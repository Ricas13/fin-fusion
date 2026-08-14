'use strict';

const { query } = require('../db');
const { encryptString, decryptString } = require('../crypto');
const runtimeSettings = require('../platform/runtime-settings');

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

function envConfig() {
    const baseUrl = cleanBaseUrl(runtimeSettings.overseerrUrl() || process.env.OVERSEERR_URL || process.env.SEERR_URL || '');
    const apiKey = String(process.env.SEERR_API_KEY || process.env.OVERSEERR_API_KEY || '').trim();
    return {
        source: 'environment',
        enabled: Boolean(baseUrl && apiKey),
        baseUrl,
        apiKey,
        syncIntervalMinutes: Math.max(5, Math.min(1440, Math.round(Number(process.env.REQUEST_USER_SYNC_INTERVAL_MS || 15 * 60 * 1000) / 60000) || 15)),
        updatedAt: null
    };
}

function decodeRow(row) {
    let apiKey = '';
    if (row.api_key_encrypted) apiKey = decryptString(row.api_key_encrypted) || '';
    return {
        source: 'database',
        enabled: Boolean(row.enabled),
        baseUrl: cleanBaseUrl(row.base_url || ''),
        apiKey: String(apiKey || '').trim(),
        syncIntervalMinutes: Number(row.sync_interval_minutes) || 15,
        updatedAt: row.updated_at || null
    };
}

async function load() {
    if (loading) return loading;
    loading = (async () => {
        await runtimeSettings.ensureLoaded();
        const result = await query('SELECT enabled,base_url,api_key_encrypted,sync_interval_minutes,updated_at FROM request_service_settings WHERE id=1');
        cache = result.rowCount ? decodeRow(result.rows[0]) : envConfig();
        return cache;
    })().finally(() => { loading = null; });
    return loading;
}

async function ensureLoaded() {
    if (!cache) await load();
    return cache;
}

function peek() {
    return cache || envConfig();
}

async function get() {
    await ensureLoaded();
    return peek();
}

function configured(cfg) {
    return Boolean(cfg?.enabled && cfg?.baseUrl && cfg?.apiKey);
}

async function status() {
    const cfg = await get();
    return {
        source: cfg.source,
        enabled: Boolean(cfg.enabled),
        configured: configured(cfg),
        baseUrl: cfg.baseUrl || '',
        apiKeyConfigured: Boolean(cfg.apiKey),
        syncIntervalMinutes: Number(cfg.syncIntervalMinutes) || 15,
        updatedAt: cfg.updatedAt || null
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

    await query(`
        INSERT INTO request_service_settings(id,enabled,base_url,api_key_encrypted,sync_interval_minutes,updated_by,updated_at)
        VALUES(1,$1,$2,$3,$4,$5,NOW())
        ON CONFLICT(id) DO UPDATE SET
            enabled=EXCLUDED.enabled,
            base_url=EXCLUDED.base_url,
            api_key_encrypted=EXCLUDED.api_key_encrypted,
            sync_interval_minutes=EXCLUDED.sync_interval_minutes,
            updated_by=EXCLUDED.updated_by,
            updated_at=NOW()
    `, [enabled, baseUrl || null, nextApiKey ? encryptString(nextApiKey) : null, syncIntervalMinutes, actorUserId]);

    cache = { source: 'database', enabled, baseUrl, apiKey: nextApiKey, syncIntervalMinutes, updatedAt: new Date() };
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                 VALUES($1,'admin.request_service.update','request_service','central',$2::jsonb)`,
        [actorUserId, JSON.stringify({ enabled, baseUrl, apiKeyConfigured: Boolean(nextApiKey), syncIntervalMinutes })]);
    return status();
}

async function useEnvironment(actorUserId = null) {
    await query('DELETE FROM request_service_settings WHERE id=1');
    await runtimeSettings.ensureLoaded();
    cache = envConfig();
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                 VALUES($1,'admin.request_service.use_environment','request_service','central','{}'::jsonb)`, [actorUserId]);
    return status();
}

function syncIntervalMs() {
    const cfg = peek();
    return Math.max(5, Number(cfg.syncIntervalMinutes) || 15) * 60000;
}

module.exports = { cleanBaseUrl, ensureLoaded, get, peek, status, save, useEnvironment, configured, syncIntervalMs };
