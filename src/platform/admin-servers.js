'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const registry = require('../jellyfin/registry');
const runtimeSettings = require('./runtime-settings');
const outbound = require('../security/outbound-url-policy');
const { encryptWithEnv } = require('../security/purpose-crypto');

const SERVER_CLASSES = new Set(['premium', 'free', 'custom']);
const SERVER_ID_PARAM = ':serverId([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const SAFE_ERROR_PREFIXES = [
    'Slug must be ', 'Enter a valid ', 'Only http and https ', 'URLs may not contain ',
    'URL hostname is required.', 'Internal/base URL is required.', 'Jellyfin API key is required.',
    'Jellyfin API key format is invalid.', 'Emby API key is required.', 'Emby API key format is invalid.',
    'Media-server API key is required.', 'Media-server API key format is invalid.',
    'Priority must be between ', 'Maximum users must be between ', 'Invalid server class.',
    'Invalid media server type.', 'Jellyfin returned HTTP ', 'Emby returned HTTP ',
    'Jellyfin returned an unexpected response.', 'Emby returned an unexpected response.',
    'Jellyfin validation timed out.', 'Emby validation timed out.',
    'Could not validate the Jellyfin server securely.', 'Could not validate the Emby server securely.',
    'Jellyfin destination ', 'Emby destination ', 'Jellyfin hostname ', 'Emby hostname ',
    'Could not connect to Jellyfin at ', 'Could not connect to Emby at ',
    'Server name is required.', 'Server not found.'
];

class FieldValidationError extends Error {
    constructor(field, message) { super(message); this.name = 'FieldValidationError'; this.field = field; }
}
function invalidField(field, message) { return new FieldValidationError(field, message); }
function requireNativeAdmin(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache'); next();
}
function cleanText(value, max = 120) { return String(value || '').trim().slice(0, max); }
function cleanSlug(value) {
    const slug = cleanText(value, 60).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/.test(slug)) throw invalidField('slug', 'Slug must be 3-60 lowercase letters, numbers or dashes.');
    return slug;
}
function allowedHosts() { return new Set(); }
function normalizeUrl(value, { baseUrl = false, field = null } = {}) {
    const fieldName = field || (baseUrl ? 'baseUrl' : 'publicUrl');
    const raw = cleanText(value, 500);
    if (!raw) { if (baseUrl) throw invalidField(fieldName, 'Internal/base URL is required.'); return null; }
    let parsed;
    try { parsed = new URL(raw); } catch (_) { throw invalidField(fieldName, 'Enter a valid http/https URL.'); }
    if (!['http:', 'https:'].includes(parsed.protocol)) throw invalidField(fieldName, 'Only http and https URLs are allowed.');
    if (parsed.username || parsed.password || parsed.hash) throw invalidField(fieldName, 'URLs may not contain credentials or fragments.');
    if (!parsed.hostname) throw invalidField(fieldName, 'URL hostname is required.');
    parsed.pathname = parsed.pathname.replace(/\/+$/, ''); parsed.search = ''; parsed.hash = '';
    return parsed.toString().replace(/\/$/, '');
}
function mediaServerType(value) {
    try { return registry.mediaProvider.normalizeType(cleanText(value, 20) || 'jellyfin'); }
    catch (_) { throw invalidField('mediaServerType', 'Invalid media server type. Choose Jellyfin or Emby.'); }
}
function validateApiKey(value, required = true, type = 'jellyfin') {
    const key = String(value || '').trim(), providerLabel = registry.mediaProvider.label(type);
    if (!key && required) throw invalidField('apiKey', `${providerLabel} API key is required.`);
    if (!key && !required) return null;
    if (key.length < 16 || key.length > 256 || /[\s\x00-\x1f\x7f]/.test(key)) throw invalidField('apiKey', `${providerLabel} API key format is invalid.`);
    return key;
}
function boolField(value) { return value === 'on' || value === 'true' || value === true || value === '1'; }
function intField(value, { min = 0, max = 100000, nullable = false, field = null, label = 'Number' } = {}) {
    if ((value === '' || value == null) && nullable) return null;
    const number = Number(value);
    if (!Number.isInteger(number) || number < min || number > max) throw invalidField(field, `${label} must be between ${min} and ${max}.`);
    return number;
}
function safeAdminErrorInfo(error) {
    if (error instanceof FieldValidationError) return { message: error.message, field: error.field || null };
    if (error?.code === '23505') {
        const constraint = String(error.constraint || '').toLowerCase();
        const field = constraint.includes('slug') ? 'slug' : constraint.includes('name') ? 'name' : null;
        return { message: 'A server with that name or slug already exists.', field };
    }
    const message = String(error?.message || '');
    if (SAFE_ERROR_PREFIXES.some(prefix => message.startsWith(prefix))) return { message, field: error?.field || null };
    return { message: 'The server change could not be completed safely.', field: null };
}
function safeAdminError(error) { return safeAdminErrorInfo(error).message; }
function formErrorRedirect(path, error) {
    const info = safeAdminErrorInfo(error), params = new URLSearchParams({ error: info.message });
    if (info.field) params.set('field', info.field); return `${path}?${params.toString()}`;
}
function parseServerForm(body, { apiKeyRequired = false } = {}) {
    const name = cleanText(body.name, 100); if (!name) throw invalidField('name', 'Server name is required.');
    const serverClass = cleanText(body.serverClass, 20).toLowerCase();
    if (!SERVER_CLASSES.has(serverClass)) throw invalidField('serverClass', 'Invalid server class.');
    const type = mediaServerType(body.mediaServerType);
    return {
        name, slug: cleanSlug(body.slug), serverClass, mediaServerType: type,
        baseUrl: normalizeUrl(body.baseUrl, { baseUrl: true, field: 'baseUrl' }),
        publicUrl: normalizeUrl(body.publicUrl, { field: 'publicUrl' }),
        location: cleanText(body.location, 100) || null,
        priority: intField(body.priority, { min: 0, max: 10000, field: 'priority', label: 'Priority' }),
        maxUsers: intField(body.maxUsers, { min: 1, max: 100000, nullable: true, field: 'maxUsers', label: 'Maximum users' }),
        allowNewUsers: boolField(body.allowNewUsers), trialEnabled: boolField(body.trialEnabled),
        paidEnabled: boolField(body.paidEnabled), apiKey: validateApiKey(body.apiKey, apiKeyRequired, type)
    };
}
function headerValue(headers,name){if(!headers)return'';if(typeof headers.get==='function')return headers.get(name)||'';return headers[String(name).toLowerCase()]||headers[name]||'';}
function connectionPolicyMessage(error,baseUrl,type='jellyfin'){
    const message=String(error?.message||''),providerLabel=registry.mediaProvider.label(type);
    if(/private address that is not explicitly allowed/i.test(message))return `${providerLabel} destination resolves to a private address. Enable private integrations and add this ${providerLabel} hostname or network CIDR to the trusted outbound destinations in Settings, then retry.`;
    if(/resolved to a blocked/i.test(message))return `${providerLabel} destination is blocked by outbound network safety: ${message.replace(/^.*server validation destination\s*/i,'')}`;
    if(/hostname did not resolve|ENOTFOUND|EAI_AGAIN/i.test(message))return `${providerLabel} hostname could not be resolved. Check the internal/base URL and DNS from the CAPTAiNFiN host.`;
    if(/ECONNREFUSED/i.test(message))return `Could not connect to ${providerLabel} at ${baseUrl}. The host resolved, but the connection was refused.`;
    if(/ETIMEDOUT|timeout/i.test(message))return `Could not connect to ${providerLabel} at ${baseUrl} before the connection timed out.`;
    return null;
}
async function probeCredentials(baseUrl, apiKey, type='jellyfin') {
    const provider=mediaServerType(type),providerLabel=registry.mediaProvider.label(provider);
    try {
        const path=registry.mediaProvider.apiPath(provider, registry.mediaProvider.credentialProbeEndpoint(provider));
        const response = await outbound.safeFetch(new URL(path, `${baseUrl}/`), { purpose: `${providerLabel} server validation`, method: 'GET', timeoutMs: 5000, maxBytes: 1024*1024, headers: registry.authHeaders(apiKey,{mediaServerType:provider}) });
        if (response.status === 401) throw invalidField('apiKey', `${providerLabel} returned HTTP 401 — API key was not accepted.`);
        if (response.status === 403) throw invalidField('baseUrl', `${providerLabel} returned HTTP 403 — request was blocked by the ${providerLabel} server or reverse proxy.`);
        if (!response.ok) throw invalidField('baseUrl', `${providerLabel} returned HTTP ${response.status} while validating the server.`);
        if (!String(headerValue(response.headers,'content-type')).includes('application/json')) throw invalidField('baseUrl', `${providerLabel} returned an unexpected response.`);
        const info = await response.json();
        if (!info || typeof info !== 'object' || Array.isArray(info)) throw invalidField('baseUrl', `${providerLabel} returned an unexpected response.`);
        return info;
    } catch (error) {
        if (error instanceof FieldValidationError) throw error;
        if (error.name === 'AbortError') throw invalidField('baseUrl', `${providerLabel} validation timed out.`);
        const useful=connectionPolicyMessage(error,baseUrl,provider);if(useful)throw invalidField('baseUrl',useful);
        if (String(error.message||'').startsWith(`${providerLabel} `)) throw invalidField('baseUrl',String(error.message));
        throw invalidField('baseUrl', `Could not validate the ${providerLabel} server securely. Check that CAPTAiNFiN can reach the internal/base URL and that the API key is valid.`);
    }
}
async function serverList() {
    const result = await query(`
        SELECT js.id,js.name,js.slug,js.server_class,js.media_server_type,js.public_url,js.location,js.enabled,
               js.allow_new_users,js.trial_enabled,js.paid_enabled,js.priority,js.max_users,
               js.health_status,js.last_health_check,js.created_at,js.updated_at,
               COUNT(DISTINCT ja.id)::int assigned_users,COUNT(DISTINCT aps.jellyfin_session_id)::int active_streams
        FROM jellyfin_servers js LEFT JOIN jellyfin_accounts ja ON ja.server_id=js.id
        LEFT JOIN active_playback_sessions aps ON aps.server_id=js.id
        GROUP BY js.id ORDER BY js.priority,js.name`);
    return result.rows;
}
async function serverDetail(serverId) {
    const result = await query(`SELECT id,name,slug,server_class,media_server_type,base_url,public_url,location,enabled,allow_new_users,
        trial_enabled,paid_enabled,priority,max_users,health_status,last_health_check,created_at,updated_at
        FROM jellyfin_servers WHERE id=$1`, [serverId]);
    return result.rows[0] || null;
}
async function serverImpact(serverId) {
    const result = await query(`SELECT
        (SELECT COUNT(*)::int FROM jellyfin_accounts WHERE server_id=$1) assigned_accounts,
        (SELECT COUNT(DISTINCT customer_id)::int FROM jellyfin_accounts WHERE server_id=$1) managed_customers,
        (SELECT COUNT(DISTINCT jellyfin_session_id)::int FROM active_playback_sessions WHERE server_id=$1) active_streams,
        (SELECT COUNT(*)::int FROM plan_server_eligibility WHERE server_id=$1) explicit_plan_rules,
        (SELECT COALESCE(string_agg(p.name, ', ' ORDER BY p.name),'') FROM plan_server_eligibility pse JOIN plans p ON p.id=pse.plan_id WHERE pse.server_id=$1) plan_names`, [serverId]);
    return result.rows[0] || { assigned_accounts: 0, managed_customers: 0, active_streams: 0, explicit_plan_rules: 0, plan_names: '' };
}
function riskyServerChange(server, form, impact) {
    const reasons = [];
    if (String(server.server_class) !== String(form.serverClass)) reasons.push(`server class ${server.server_class} → ${form.serverClass}`);
    if (registry.mediaProvider.normalizeType(server.media_server_type) !== form.mediaServerType) reasons.push(`media server ${registry.mediaProvider.label(server.media_server_type)} → ${registry.mediaProvider.label(form.mediaServerType)}`);
    if (String(server.base_url) !== String(form.baseUrl)) reasons.push('internal/base URL');
    if (server.paid_enabled && !form.paidEnabled) reasons.push('paid-placement disabled');
    if (server.trial_enabled && !form.trialEnabled) reasons.push('trial-placement disabled');
    return { risky: reasons.length > 0 && (Number(impact.assigned_accounts) > 0 || Number(impact.explicit_plan_rules) > 0), reasons };
}
async function persistHealthCheck(serverId, status) {
    const result = await query(`UPDATE jellyfin_servers SET health_status=$2,last_health_check=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1 RETURNING last_health_check`, [serverId, status]);
    if (!result.rowCount) throw new Error('Server not found.'); return result.rows[0].last_health_check;
}
async function createServer(actorUserId, form) {
    await probeCredentials(form.baseUrl, form.apiKey, form.mediaServerType);
    return transaction(async client => {
        const result = await client.query(`INSERT INTO jellyfin_servers(name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,enabled,priority,max_users,location,allow_new_users,trial_enabled,paid_enabled,health_status,last_health_check)
            VALUES($1,$2,$3,$4,$5,$6,$7,TRUE,$8,$9,$10,$11,$12,$13,'unknown',NULL) RETURNING id`, [form.name,form.slug,form.serverClass,form.mediaServerType,form.baseUrl,form.publicUrl,encryptWithEnv(form.apiKey,'JELLYFIN_ENCRYPTION_KEY','jf1'),form.priority,form.maxUsers,form.location,form.allowNewUsers,form.trialEnabled,form.paidEnabled]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.server.create','jellyfin_server',$2,$3::jsonb)`, [actorUserId,result.rows[0].id,JSON.stringify({mediaServerType:form.mediaServerType,fields:['name','slug','serverClass','mediaServerType','baseUrl','publicUrl','priority','maxUsers','placement','apiKey']})]);
        return result.rows[0].id;
    });
}
async function updateServer(actorUserId, serverId, form) {
    const current = await registry.getServerSecret(serverId); if (!current) throw new Error('Server not found.');
    const candidateKey = form.apiKey || current.apiKey, providerChanged=form.mediaServerType!==registry.mediaProvider.normalizeType(current.media_server_type), connectivityChanged = form.baseUrl !== current.base_url || Boolean(form.apiKey) || providerChanged;
    if (connectivityChanged) await probeCredentials(form.baseUrl, candidateKey, form.mediaServerType);
    await transaction(async client => {
        const result = await client.query(`UPDATE jellyfin_servers SET name=$2,slug=$3,server_class=$4,media_server_type=$5,base_url=$6,public_url=$7,location=$8,
            priority=$9,max_users=$10,allow_new_users=$11,trial_enabled=$12,paid_enabled=$13,
            api_key_encrypted=CASE WHEN $14::text IS NULL THEN api_key_encrypted ELSE $14 END,
            health_status=CASE WHEN base_url<>$6 OR media_server_type<>$5 OR $14::text IS NOT NULL THEN 'unknown' ELSE health_status END,updated_at=NOW()
            WHERE id=$1 RETURNING id`, [serverId,form.name,form.slug,form.serverClass,form.mediaServerType,form.baseUrl,form.publicUrl,form.location,form.priority,form.maxUsers,form.allowNewUsers,form.trialEnabled,form.paidEnabled,form.apiKey?encryptWithEnv(form.apiKey,'JELLYFIN_ENCRYPTION_KEY','jf1'):null]);
        if (!result.rowCount) throw new Error('Server not found.');
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.server.update','jellyfin_server',$2,$3::jsonb)`, [actorUserId,serverId,JSON.stringify({mediaServerType:form.mediaServerType,providerChanged,credentialRotated:Boolean(form.apiKey),connectivityChanged})]);
    });
}
async function renderLocals(req, server = null, error = null) {
    await runtimeSettings.ensureLoaded().catch(()=>{});
    return { siteName: runtimeSettings.siteName(), server, impact: server ? await serverImpact(server.id) : null, csrfToken: csrf.token(req), error };
}
function createAdminServersRouter() {
    const router = express.Router(); router.use('/admin/servers', requireNativeAdmin, noStore);
    router.get('/admin/servers/new', async (req,res,next) => { try { return res.render('admin/server-form', await renderLocals(req)); } catch(error){next(error);} });
    router.get(`/admin/servers/${SERVER_ID_PARAM}/edit`, async (req,res,next) => { try { const server=await serverDetail(req.params.serverId); if(!server)return res.status(404).send('Server not found'); return res.render('admin/server-form',await renderLocals(req,server)); } catch(error){next(error);} });
    router.post('/admin/servers', async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { const form=parseServerForm(req.body,{apiKeyRequired:true}),id=await createServer(req.session.authUserId,form),providerLabel=registry.mediaProvider.label(form.mediaServerType); try{await registry.healthcheckServer(id);}catch(_){} return res.redirect('/admin/servers?message='+encodeURIComponent(`${providerLabel} server added and credentials validated.`)); }
        catch(error){console.warn('Admin server create rejected:',error.message);return res.redirect(formErrorRedirect('/admin/servers/new',error));}
    });
    router.post(`/admin/servers/${SERVER_ID_PARAM}/test`, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const started=Date.now();
        try { const server=await serverDetail(req.params.serverId),secret=await registry.getServerSecret(req.params.serverId); if(!server||!secret)return res.status(404).send('Server not found'); const info=await probeCredentials(secret.base_url,secret.apiKey,secret.media_server_type),latencyMs=Date.now()-started,serverName=cleanText(info.ServerName,100)||server.name,version=cleanText(info.Version,40),checkedAt=await persistHealthCheck(req.params.serverId,'healthy'),providerLabel=registry.mediaProvider.label(secret.media_server_type); await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.server.connection_test','jellyfin_server',$2,$3::jsonb)`,[req.session.authUserId,req.params.serverId,JSON.stringify({ok:true,provider:secret.media_server_type,latencyMs,version:version||null,checkedAt})]); return res.redirect('/admin/servers?message='+encodeURIComponent(`Connection successful — ${serverName}${version?` · ${providerLabel} ${version}`:''} · ${latencyMs} ms.`)); }
        catch(error){await persistHealthCheck(req.params.serverId,'offline').catch(()=>{});console.warn('Admin server connection test failed:',error.message);return res.redirect('/admin/servers?error='+encodeURIComponent(`Connection failed — ${safeAdminError(error)}`));}
    });
    router.post(`/admin/servers/${SERVER_ID_PARAM}`, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const server=await serverDetail(req.params.serverId); if(!server)return res.status(404).send('Server not found');
            const form=parseServerForm(req.body,{apiKeyRequired:false}),impact=await serverImpact(req.params.serverId),risk=riskyServerChange(server,form,impact);
            if (risk.risky && String(req.body.confirmation||'').trim() !== 'CHANGE') throw invalidField('confirmation', `This server has ${impact.assigned_accounts} assigned account(s) and ${impact.explicit_plan_rules} explicit plan rule(s). Type CHANGE to confirm: ${risk.reasons.join(', ')}.`);
            await updateServer(req.session.authUserId,req.params.serverId,form);
            return res.redirect('/admin/servers?message='+encodeURIComponent('Server configuration updated.'));
        } catch(error){console.warn('Admin server update rejected:',error.message);return res.redirect(formErrorRedirect('/admin/servers/'+encodeURIComponent(req.params.serverId)+'/edit',error));}
    });
    router.post(`/admin/servers/${SERVER_ID_PARAM}/health`, async (req,res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try { const server=await serverDetail(req.params.serverId); if(!server)return res.status(404).send('Server not found'); const result=await registry.healthcheckServer(req.params.serverId); await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.server.healthcheck','jellyfin_server',$2,$3::jsonb)`,[req.session.authUserId,req.params.serverId,JSON.stringify({ok:result.ok,provider:result.provider||server.media_server_type,latencyMs:result.latencyMs})]); return res.redirect('/admin/servers?'+(result.ok?'message=':'error=')+encodeURIComponent(result.ok?`Server health check passed (${result.latencyMs} ms).`:'Server health check failed.')); }
        catch(error){return res.redirect('/admin/servers?error='+encodeURIComponent('Server health check could not be completed.'));}
    });
    router.use('/admin/servers', async (error,_req,res,_next) => { console.error('Admin servers route error:',error.message); await runtimeSettings.ensureLoaded().catch(()=>{}); return res.status(500).render('auth/message',{siteName:runtimeSettings.siteName(),title:'Servers unavailable',message:'Server administration could not be loaded safely.',link:'/admin',linkText:'Return to Administration'}); });
    return router;
}
module.exports = { createAdminServersRouter,serverList,serverDetail,serverImpact,riskyServerChange,parseServerForm,normalizeUrl,allowedHosts,probeCredentials,safeAdminError,safeAdminErrorInfo,persistHealthCheck,FieldValidationError,connectionPolicyMessage,mediaServerType };
