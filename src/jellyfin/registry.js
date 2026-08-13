const { query } = require('../db');
const { decryptString } = require('../crypto');
const { decryptWithEnv } = require('../security/purpose-crypto');

function normalizeBaseUrl(url) {
    return String(url || '').replace(/\/+$/, '');
}

function decryptJellyfinKey(payload) {
    if (!payload) return null;
    if (String(payload).startsWith('jf1:')) {
        return decryptWithEnv(payload, 'JELLYFIN_ENCRYPTION_KEY', 'jf1');
    }
    if (String(payload).startsWith('v1:') && process.env.DATA_ENCRYPTION_KEY) {
        return decryptString(payload);
    }
    if (String(payload).startsWith('v1:')) {
        throw new Error('Legacy Jellyfin key must be rotated before this process can use it');
    }
    throw new Error('Unsupported Jellyfin key format');
}

async function listServers({ enabledOnly = true, serverClass = null } = {}) {
    const params = [];
    const where = [];
    if (enabledOnly) where.push('enabled = TRUE');
    if (serverClass) {
        params.push(serverClass);
        where.push(`server_class = $${params.length}`);
    }

    const result = await query(`
        SELECT id,name,slug,server_class,base_url,public_url,enabled,priority,max_users,health_status,last_health_check
        FROM jellyfin_servers
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY priority ASC, name ASC
    `, params);
    return result.rows;
}

async function getServerSecret(serverId) {
    const result = await query(`
        SELECT id,name,slug,server_class,base_url,public_url,enabled,priority,max_users,api_key_encrypted
        FROM jellyfin_servers WHERE id = $1
    `, [serverId]);
    if (!result.rowCount) return null;
    const server = result.rows[0];
    return {
        ...server,
        base_url: normalizeBaseUrl(server.base_url),
        apiKey: decryptJellyfinKey(server.api_key_encrypted)
    };
}

async function request(serverId, endpoint, { method = 'GET', body = null, timeoutMs = 10000 } = {}) {
    const server = await getServerSecret(serverId);
    if (!server || !server.enabled) throw new Error('Jellyfin server is unavailable or disabled');

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(`${server.base_url}${endpoint}`, {
            method,
            signal: controller.signal,
            headers: {
                'X-Emby-Token': server.apiKey,
                'Accept': 'application/json',
                ...(body ? { 'Content-Type': 'application/json' } : {})
            },
            ...(body ? { body: JSON.stringify(body) } : {})
        });

        const text = await response.text();
        let parsed = null;
        if (text) {
            try { parsed = JSON.parse(text); } catch { parsed = text; }
        }

        if (!response.ok) {
            const err = new Error(`Jellyfin ${server.name} returned HTTP ${response.status}`);
            err.status = response.status;
            err.response = parsed;
            throw err;
        }
        return parsed ?? {};
    } finally {
        clearTimeout(timer);
    }
}

async function healthcheckServer(serverId) {
    const started = Date.now();
    try {
        const info = await request(serverId, '/System/Info/Public', { timeoutMs: 5000 });
        await query(`UPDATE jellyfin_servers SET health_status='healthy',last_health_check=NOW(),updated_at=NOW() WHERE id=$1`, [serverId]);
        return { ok: true, latencyMs: Date.now() - started, info };
    } catch (err) {
        await query(`UPDATE jellyfin_servers SET health_status='offline',last_health_check=NOW(),updated_at=NOW() WHERE id=$1`, [serverId]);
        return { ok: false, latencyMs: Date.now() - started, error: err.message };
    }
}

module.exports = { listServers, getServerSecret, request, healthcheckServer, decryptJellyfinKey };
