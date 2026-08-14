'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const runtimeSettings = require('../platform/runtime-settings');

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

function apiKey() {
    return String(process.env.SEERR_API_KEY || process.env.OVERSEERR_API_KEY || '').trim();
}

async function configuration() {
    await runtimeSettings.ensureLoaded();
    const baseUrl = cleanBaseUrl(runtimeSettings.overseerrUrl());
    const key = apiKey();
    return { baseUrl, apiKey: key, configured: Boolean(baseUrl && key) };
}

async function apiRequest(path, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
    const config = await configuration();
    if (!config.baseUrl) throw new Error('External request site URL is not configured.');
    if (!config.apiKey) throw new Error('SEERR_API_KEY or OVERSEERR_API_KEY is not configured.');
    if (typeof path !== 'string' || !path.startsWith('/api/v1/') || path.startsWith('//')) throw new Error('Invalid requests API path.');
    const base = new URL(`${config.baseUrl}/`);
    const url = new URL(path.replace(/^\//, ''), base);
    if (url.origin !== base.origin) throw new Error('Requests API path escaped configured origin.');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, {
            method,
            redirect: 'error',
            signal: controller.signal,
            headers: {
                Accept: 'application/json',
                'X-Api-Key': config.apiKey,
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        });
        const text = await response.text();
        let parsed = null;
        if (text) {
            try { parsed = JSON.parse(text); } catch (_) { parsed = text; }
        }
        if (!response.ok) {
            const detail = typeof parsed === 'object' && parsed?.message ? `: ${parsed.message}` : '';
            const error = new Error(`Requests service returned HTTP ${response.status}${detail}`);
            error.status = response.status;
            error.response = parsed;
            throw error;
        }
        return parsed ?? {};
    } finally {
        clearTimeout(timer);
    }
}

function validEmail(value) {
    const email = String(value || '').trim().toLowerCase();
    return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

function cleanUsername(value) {
    const username = String(value || '').trim().replace(/[^A-Za-z0-9._-]/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
    return username || 'user';
}

function fallbackEmail(customerId) {
    const compact = String(customerId || '').replace(/[^a-f0-9]/gi, '').toLowerCase().slice(0, 24) || crypto.randomBytes(8).toString('hex');
    return `cf-${compact}@captainfin.invalid`;
}

async function syncCandidates() {
    const result = await query(`
        SELECT c.id AS customer_id,
               COALESCE(NULLIF(u.email,''),NULLIF(c.email,'')) AS email,
               COALESCE(NULLIF(u.username,''),NULLIF(c.display_name,''),MIN(ja.jellyfin_username),'user') AS username,
               COUNT(DISTINCT ja.server_id)::int AS active_server_count,
               STRING_AGG(DISTINCT js.name, ', ' ORDER BY js.name) AS active_servers,
               rus.external_user_id,rus.external_email,rus.external_username,
               rus.status,rus.password_reset_required,rus.last_error,
               rus.last_attempt_at,rus.last_success_at
        FROM customers c
        LEFT JOIN app_users u ON u.id=c.user_id
        JOIN jellyfin_accounts ja ON ja.customer_id=c.id AND ja.disabled=FALSE
        JOIN jellyfin_servers js ON js.id=ja.server_id AND js.enabled=TRUE
        LEFT JOIN request_user_sync rus ON rus.customer_id=c.id
        GROUP BY c.id,u.email,u.username,rus.external_user_id,rus.external_email,
                 rus.external_username,rus.status,rus.password_reset_required,rus.last_error,
                 rus.last_attempt_at,rus.last_success_at
        ORDER BY COALESCE(NULLIF(u.username,''),NULLIF(c.display_name,''),MIN(ja.jellyfin_username),'user')
    `);
    return result.rows;
}

async function externalUsers() {
    const users = [];
    const take = 100;
    for (let skip = 0; skip < 100000; skip += take) {
        const page = await apiRequest(`/api/v1/user?take=${take}&skip=${skip}&sort=displayname`);
        const rows = Array.isArray(page?.results) ? page.results : [];
        users.push(...rows);
        if (rows.length < take || (Number(page?.pageInfo?.results || 0) && users.length >= Number(page.pageInfo.results))) break;
    }
    return users;
}

async function mark(customerId, fields) {
    const status = fields.status || 'pending';
    await query(`
        INSERT INTO request_user_sync(
            customer_id,external_user_id,external_email,external_username,status,
            password_reset_required,last_error,last_attempt_at,last_success_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,NOW(),CASE WHEN $5='synced' THEN NOW() ELSE NULL END,NOW())
        ON CONFLICT(customer_id) DO UPDATE SET
            external_user_id=COALESCE(EXCLUDED.external_user_id,request_user_sync.external_user_id),
            external_email=COALESCE(EXCLUDED.external_email,request_user_sync.external_email),
            external_username=COALESCE(EXCLUDED.external_username,request_user_sync.external_username),
            status=EXCLUDED.status,
            password_reset_required=EXCLUDED.password_reset_required,
            last_error=EXCLUDED.last_error,
            last_attempt_at=NOW(),
            last_success_at=CASE WHEN EXCLUDED.status='synced' THEN NOW() ELSE request_user_sync.last_success_at END,
            updated_at=NOW()
    `, [
        customerId,
        fields.externalUserId || null,
        fields.email || null,
        fields.username || null,
        status,
        Boolean(fields.passwordResetRequired),
        fields.error ? String(fields.error).slice(0, 1000) : null
    ]);
}

async function syncCustomer(candidate, indexes = {}) {
    const username = cleanUsername(candidate.username);
    const email = validEmail(candidate.email) || candidate.external_email || fallbackEmail(candidate.customer_id);
    try {
        let external = candidate.external_user_id ? indexes.byId?.get(String(candidate.external_user_id)) : null;
        if (!external) external = indexes.byEmail?.get(String(email).toLowerCase()) || null;
        let created = false;
        if (!external) {
            const bootstrapPassword = crypto.randomBytes(30).toString('base64url');
            external = await apiRequest('/api/v1/user', {
                method: 'POST',
                body: { email, username, password: bootstrapPassword }
            });
            created = true;
            if (external?.id && indexes.byId) indexes.byId.set(String(external.id), external);
            if (external?.email && indexes.byEmail) indexes.byEmail.set(String(external.email).toLowerCase(), external);
        }
        if (!external?.id) throw new Error('Request service did not return a user ID.');
        await mark(candidate.customer_id, {
            status: 'synced',
            externalUserId: external.id,
            email: external.email || email,
            username: external.username || username,
            passwordResetRequired: created || Boolean(candidate.password_reset_required)
        });
        return { status: 'synced', customerId: candidate.customer_id, created };
    } catch (error) {
        await mark(candidate.customer_id, {
            status: 'failed', email, username,
            passwordResetRequired: Boolean(candidate.password_reset_required),
            error: error.message
        });
        return { status: 'failed', customerId: candidate.customer_id, error: error.message };
    }
}

function indexesFor(users) {
    return {
        byId: new Map(users.filter(user => user?.id != null).map(user => [String(user.id), user])),
        byEmail: new Map(users.filter(user => user?.email).map(user => [String(user.email).toLowerCase(), user]))
    };
}

async function syncAll() {
    const config = await configuration();
    if (!config.configured) throw new Error('Configure an external request site URL and SEERR_API_KEY/OVERSEERR_API_KEY first.');
    const [candidates, existing] = await Promise.all([syncCandidates(), externalUsers()]);
    const indexes = indexesFor(existing);
    const summary = { total: candidates.length, created: 0, linked: 0, failed: 0 };
    for (const candidate of candidates) {
        const result = await syncCustomer(candidate, indexes);
        if (result.status === 'failed') summary.failed += 1;
        else if (result.created) summary.created += 1;
        else summary.linked += 1;
    }
    return summary;
}

async function syncOneCustomer(customerId) {
    const candidates = await syncCandidates();
    const candidate = candidates.find(row => String(row.customer_id) === String(customerId));
    if (!candidate) throw new Error('Customer has no active Jellyfin account to sync.');
    const existing = await externalUsers();
    return syncCustomer(candidate, indexesFor(existing));
}

async function requestAccessForCustomer(customerId) {
    const result = await query(`
        SELECT rus.*,COALESCE(NULLIF(u.email,''),NULLIF(c.email,'')) AS customer_email
        FROM customers c
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN request_user_sync rus ON rus.customer_id=c.id
        WHERE c.id=$1
    `, [customerId]);
    return result.rows[0] || null;
}

async function setCustomerPassword(customerId, password) {
    if (typeof password !== 'string' || password.length < 12 || password.length > 200) {
        throw new Error('Request-site password must be between 12 and 200 characters.');
    }
    let access = await requestAccessForCustomer(customerId);
    if (!access?.external_user_id) {
        const result = await syncOneCustomer(customerId);
        if (result.status !== 'synced') throw new Error(result.error || 'Request-site user could not be synced.');
        access = await requestAccessForCustomer(customerId);
    }
    if (!access?.external_user_id) throw new Error('Request-site user is not synced yet.');
    await apiRequest(`/api/v1/user/${encodeURIComponent(access.external_user_id)}/settings/password`, {
        method: 'POST',
        body: { newPassword: password }
    });
    await query(`
        UPDATE request_user_sync
        SET status='synced',password_reset_required=FALSE,last_error=NULL,last_success_at=NOW(),updated_at=NOW()
        WHERE customer_id=$1
    `, [customerId]);
    return true;
}

async function statusSummary() {
    const [config, counts] = await Promise.all([
        configuration(),
        query(`SELECT status,COUNT(*)::int AS count FROM request_user_sync GROUP BY status`)
    ]);
    return {
        ...config,
        counts: Object.fromEntries(counts.rows.map(row => [row.status, row.count]))
    };
}

module.exports = {
    cleanBaseUrl,
    configuration,
    apiRequest,
    validEmail,
    cleanUsername,
    fallbackEmail,
    syncCandidates,
    externalUsers,
    syncAll,
    syncOneCustomer,
    requestAccessForCustomer,
    setCustomerPassword,
    statusSummary
};
