'use strict';

const { query, transaction } = require('../db');
const { encryptString, decryptString } = require('../crypto');
const runtimeSettings = require('../platform/runtime-settings');

const ENV_SEERR_API_KEY = String(process.env.SEERR_API_KEY || '').trim();
const ENV_OVERSEERR_API_KEY = String(process.env.OVERSEERR_API_KEY || '').trim();
const ENV_REQUEST_URL = String(process.env.SEERR_URL || process.env.OVERSEERR_URL || '').trim();
const ENV_SYNC_INTERVAL_MS = Number(process.env.REQUEST_USER_SYNC_INTERVAL_MS || 15 * 60 * 1000);

let cache = null;
let loading = null;

function cleanBaseUrl(value) {
    const raw = String(value || '').trim();
    if (!raw) return '';
    let parsed;
    try { parsed = new URL(raw); } catch (_) { throw new Error('Enter a valid Overseerr/Seerr URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Requests URL must use http or https.');
    if (parsed.username || parsed.password || parsed.hash) throw new Error('Requests URL may not contain credentials or fragments.');
    parsed.search = '';
    parsed.hash = '';
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return parsed.toString().replace(/\/$/, '');
}

function originalEnvApiKey() { return ENV_SEERR_API_KEY || ENV_OVERSEERR_API_KEY; }
function envConfig() {
    const baseUrl = cleanBaseUrl(runtimeSettings.overseerrUrl() || ENV_REQUEST_URL || '');
    const apiKey = originalEnvApiKey();
    return {
        source: 'environment', enabled: Boolean(baseUrl && apiKey), baseUrl, apiKey,
        syncIntervalMinutes: Math.max(5, Math.min(1440, Math.round(ENV_SYNC_INTERVAL_MS / 60000) || 15)), updatedAt: null
    };
}
function decodeRow(row) {
    let apiKey = '';
    if (row.api_key_encrypted) apiKey = decryptString(row.api_key_encrypted) || '';
    const migratedCompatibilityRow = !row.updated_by && !row.api_key_encrypted;
    if (!apiKey && migratedCompatibilityRow) apiKey = originalEnvApiKey();
    const baseUrl = cleanBaseUrl(row.base_url || '');
    const enabled = migratedCompatibilityRow ? Boolean(baseUrl && apiKey) : Boolean(row.enabled);
    return {
        source: migratedCompatibilityRow ? 'environment-migration' : 'database', enabled, baseUrl,
        apiKey: String(apiKey || '').trim(), syncIntervalMinutes: Number(row.sync_interval_minutes) || 15,
        updatedAt: row.updated_at || null
    };
}
function applyRuntime(cfg) {
    const activeKey = cfg?.enabled ? String(cfg.apiKey || '').trim() : '';
    process.env.SEERR_API_KEY = activeKey;
    process.env.OVERSEERR_API_KEY = '';
    process.env.REQUEST_USER_SYNC_INTERVAL_MS = String(Math.max(5, Number(cfg?.syncIntervalMinutes) || 15) * 60000);
}
async function mirrorUrl(baseUrl) {
    await query(`INSERT INTO platform_settings(setting_key,setting_value,updated_at)
        VALUES('platform',$1::jsonb,NOW()) ON CONFLICT(setting_key) DO UPDATE SET
        setting_value=platform_settings.setting_value || EXCLUDED.setting_value,updated_at=NOW()`,
    [JSON.stringify({ overseerrUrl: baseUrl || '' })]);
    await runtimeSettings.reload();
}
async function syncAutomationSchedule({enabled,syncIntervalMinutes}) {
    const result=await query(`UPDATE automation_job_state
        SET interval_seconds=$2,enabled=$3,
            next_run_at=CASE WHEN $3 THEN LEAST(COALESCE(next_run_at,NOW()),NOW()) ELSE next_run_at END,
            force_run_requested=CASE WHEN $3 THEN force_run_requested ELSE FALSE END,updated_at=NOW()
        WHERE job_key='request_users' RETURNING *`, ['request_users', syncIntervalMinutes*60, Boolean(enabled)]);
    if(!result.rowCount){
        await query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at)
            VALUES('request_users',$1,$2,CASE WHEN $1 THEN NOW() ELSE NULL END)`,[Boolean(enabled),syncIntervalMinutes*60]);
    }
}
async function load() {
    if (loading) return loading;
    loading = (async () => {
        await runtimeSettings.ensureLoaded();
        const result = await query('SELECT enabled,base_url,api_key_encrypted,sync_interval_minutes,updated_by,updated_at FROM request_service_settings WHERE id=1');
        cache = result.rowCount ? decodeRow(result.rows[0]) : envConfig();
        applyRuntime(cache);
        return cache;
    })().finally(() => { loading = null; });
    return loading;
}
async function ensureLoaded() { if (!cache) await load(); return cache; }
function peek() { return cache || envConfig(); }
async function get() { await ensureLoaded(); return peek(); }
function configured(cfg) { return Boolean(cfg?.enabled && cfg?.baseUrl && cfg?.apiKey); }
async function status() {
    const cfg = await get();
    const schedule = await query(`SELECT enabled,interval_seconds,last_success_at,last_error,next_run_at
        FROM automation_job_state WHERE job_key='request_users'`).catch(() => ({ rows: [] }));
    const job = schedule.rows[0] || null;
    return {
        source: cfg.source, enabled: Boolean(cfg.enabled), configured: configured(cfg), baseUrl: cfg.baseUrl || '',
        apiKeyConfigured: Boolean(cfg.apiKey), syncIntervalMinutes: job ? Math.round(Number(job.interval_seconds || 900)/60) : Number(cfg.syncIntervalMinutes)||15,
        updatedAt: cfg.updatedAt || null, automation: job
    };
}
async function save(input, actorUserId = null) {
    const current = await get();
    const enabled = Boolean(input.enabled);
    const baseUrl = cleanBaseUrl(input.baseUrl || '');
    const syncIntervalMinutes = Math.max(5, Math.min(1440, parseInt(input.syncIntervalMinutes, 10) || 15));
    const nextApiKey = input.clearApiKey ? '' : (String(input.apiKey || '').trim() || current.apiKey || '');
    if (enabled && !baseUrl) throw new Error('Request service URL is required while the integration is enabled.');
    if (enabled && !nextApiKey) throw new Error('Request service API key is required while the integration is enabled.');
    await transaction(async client => {
        await client.query(`INSERT INTO request_service_settings(id,enabled,base_url,api_key_encrypted,sync_interval_minutes,updated_by,updated_at)
            VALUES(1,$1,$2,$3,$4,$5,NOW()) ON CONFLICT(id) DO UPDATE SET enabled=EXCLUDED.enabled,
            base_url=EXCLUDED.base_url,api_key_encrypted=EXCLUDED.api_key_encrypted,
            sync_interval_minutes=EXCLUDED.sync_interval_minutes,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
        [enabled, baseUrl || null, nextApiKey ? encryptString(nextApiKey) : null, syncIntervalMinutes, actorUserId]);
        const schedule=await client.query(`UPDATE automation_job_state
            SET interval_seconds=$2,enabled=$3,
                next_run_at=CASE WHEN $3 THEN LEAST(COALESCE(next_run_at,NOW()),NOW()) ELSE next_run_at END,
                force_run_requested=CASE WHEN $3 THEN force_run_requested ELSE FALSE END,updated_at=NOW()
            WHERE job_key='request_users' RETURNING id`,['request_users',syncIntervalMinutes*60,enabled]);
        if(!schedule.rowCount)await client.query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at) VALUES('request_users',$1,$2,CASE WHEN $1 THEN NOW() ELSE NULL END)`,[enabled,syncIntervalMinutes*60]);
    });
    cache = { source: 'database', enabled, baseUrl, apiKey: nextApiKey, syncIntervalMinutes, updatedAt: new Date() };
    applyRuntime(cache);
    await mirrorUrl(baseUrl);
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                 VALUES($1,'admin.request_service.update','request_service','central',$2::jsonb)`,
        [actorUserId, JSON.stringify({ enabled, baseUrl, apiKeyConfigured: Boolean(nextApiKey), syncIntervalMinutes })]);
    return status();
}
async function useEnvironment(actorUserId = null) {
    await query('DELETE FROM request_service_settings WHERE id=1');
    await runtimeSettings.ensureLoaded();
    cache = envConfig();
    applyRuntime(cache);
    await syncAutomationSchedule({enabled:cache.enabled,syncIntervalMinutes:cache.syncIntervalMinutes}).catch(()=>{});
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                 VALUES($1,'admin.request_service.use_environment','request_service','central','{}'::jsonb)`, [actorUserId]);
    return status();
}
async function testConnection() {
    const cfg = await get();
    if (!cfg.baseUrl) throw new Error('Request service URL is not configured.');
    if (!cfg.apiKey) throw new Error('Request service API key is not configured.');
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 10000);
    try {
        const url = new URL('/api/v1/user?take=1&skip=0&sort=displayname', `${cfg.baseUrl}/`);
        const response = await fetch(url, { method:'GET', redirect:'error', signal:controller.signal,
            headers:{ Accept:'application/json','X-Api-Key':cfg.apiKey } });
        if (!response.ok) { let detail=''; try{const body=await response.json();detail=body?.message?`: ${body.message}`:'';}catch(_){} throw new Error(`Request service returned HTTP ${response.status}${detail}`); }
        const body=await response.json().catch(()=>({}));
        return { ok:true,message:'Connected successfully. The request-service URL and API key are valid.',usersVisible:Number(body?.pageInfo?.results ?? (Array.isArray(body?.results)?body.results.length:0)) };
    } catch(error) { if(error?.name==='AbortError')throw new Error('Request service connection timed out after 10 seconds.'); throw error; }
    finally { clearTimeout(timer); }
}
function syncIntervalMs() { const cfg=peek(); return Math.max(5,Number(cfg.syncIntervalMinutes)||15)*60000; }
module.exports={cleanBaseUrl,ensureLoaded,get,peek,status,save,useEnvironment,configured,testConnection,syncIntervalMs,syncAutomationSchedule};
