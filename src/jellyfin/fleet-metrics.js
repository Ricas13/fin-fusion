'use strict';

const { query } = require('../db');
const registry = require('./registry');

function intEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function activeWindowSeconds() {
    return intEnv('FLEET_METRICS_ACTIVE_WINDOW_SECONDS', 120, 30, 600);
}

function playbackMethod(session) {
    const method = String(session?.PlayState?.PlayMethod || '').toLowerCase();
    if (method === 'directplay') return 'directplay';
    if (method === 'directstream') return 'directstream';
    if (method === 'transcode' || session?.TranscodingInfo) return 'transcode';
    return 'unknown';
}

function parseJellyfinDate(value) {
    if (!value) return null;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function userActivityDate(user) {
    return parseJellyfinDate(user?.LastActivityDate) || parseJellyfinDate(user?.LastLoginDate);
}

function isNewerActivity(currentValue, incomingValue) {
    const incoming = parseJellyfinDate(incomingValue);
    if (!incoming) return false;
    const current = parseJellyfinDate(currentValue);
    return !current || incoming.getTime() > current.getTime();
}

function activityRows(users) {
    const byUser = new Map();
    for (const user of Array.isArray(users) ? users : []) {
        if (!user?.Id) continue;
        const activityAt = userActivityDate(user);
        if (!activityAt) continue;
        const key = String(user.Id).toLowerCase();
        const previous = byUser.get(key);
        if (!previous || activityAt.getTime() > previous.activityAt.getTime()) {
            byUser.set(key, { userId: String(user.Id), activityAt });
        }
    }
    return [...byUser.values()];
}

async function persistUserActivity(serverId, users) {
    const incoming = activityRows(users);
    if (!incoming.length) return { observed: 0, updated: 0 };

    const params = [serverId];
    const values = incoming.map(row => {
        params.push(row.userId, row.activityAt.toISOString());
        const userIndex = params.length - 1;
        const activityIndex = params.length;
        return `($${userIndex}::text,$${activityIndex}::timestamptz)`;
    });
    const result = await query(`
        WITH incoming(jellyfin_user_id,activity_at) AS (
            VALUES ${values.join(',')}
        )
        UPDATE jellyfin_accounts ja
        SET last_activity_at=incoming.activity_at,
            updated_at=NOW()
        FROM incoming
        WHERE ja.server_id=$1
          AND LOWER(ja.jellyfin_user_id::text)=LOWER(incoming.jellyfin_user_id)
          AND (ja.last_activity_at IS NULL OR incoming.activity_at > ja.last_activity_at)
        RETURNING ja.id
    `, params);
    return { observed: incoming.length, updated: Number(result.rowCount || 0) };
}

async function refreshServerUserActivity(serverId) {
    const users = await registry.request(serverId, '/Users', { timeoutMs: 10000 });
    if (!Array.isArray(users)) throw new Error('Jellyfin users response was not an array');
    const activity = await persistUserActivity(serverId, users);
    return { totalUsers: users.length, observedActivity: activity.observed, updatedAccounts: activity.updated };
}

async function inventory() {
    const [servers, accounts] = await Promise.all([
        query(`SELECT id FROM jellyfin_servers WHERE enabled=TRUE ORDER BY priority,name`),
        query(`
            SELECT server_id,jellyfin_user_id
            FROM jellyfin_accounts
            WHERE jellyfin_user_id IS NOT NULL
        `)
    ]);
    const managedByServer = new Map();
    for (const account of accounts.rows) {
        const id = String(account.server_id);
        if (!managedByServer.has(id)) managedByServer.set(id, new Set());
        managedByServer.get(id).add(String(account.jellyfin_user_id).toLowerCase());
    }
    return servers.rows.map(row => ({
        serverId: String(row.id),
        managedUserIds: managedByServer.get(String(row.id)) || new Set()
    }));
}

async function persistSuccess(serverId, metrics) {
    await query(`
        INSERT INTO jellyfin_server_metrics(
            server_id,total_users,active_streams,managed_streams,transcode_streams,
            direct_stream_streams,direct_play_streams,paused_streams,observed_at,last_error,error_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NULL,NULL,NOW())
        ON CONFLICT(server_id) DO UPDATE SET
            total_users=EXCLUDED.total_users,
            active_streams=EXCLUDED.active_streams,
            managed_streams=EXCLUDED.managed_streams,
            transcode_streams=EXCLUDED.transcode_streams,
            direct_stream_streams=EXCLUDED.direct_stream_streams,
            direct_play_streams=EXCLUDED.direct_play_streams,
            paused_streams=EXCLUDED.paused_streams,
            observed_at=NOW(),
            last_error=NULL,
            error_at=NULL,
            updated_at=NOW()
    `, [
        serverId,metrics.totalUsers,metrics.activeStreams,metrics.managedStreams,
        metrics.transcodeStreams,metrics.directStreamStreams,metrics.directPlayStreams,
        metrics.pausedStreams
    ]);
}

async function persistFailure(serverId, error) {
    const message = String(error?.message || error || 'Unknown Jellyfin metrics error').slice(0, 1000);
    await query(`
        INSERT INTO jellyfin_server_metrics(server_id,last_error,error_at,updated_at)
        VALUES($1,$2,NOW(),NOW())
        ON CONFLICT(server_id) DO UPDATE SET
            last_error=EXCLUDED.last_error,
            error_at=NOW(),
            updated_at=NOW()
    `, [serverId, message]);
}

async function cachedTotalUsers(serverId) {
    const result = await query('SELECT total_users FROM jellyfin_server_metrics WHERE server_id=$1', [serverId]);
    return Number(result.rows[0]?.total_users || 0);
}

async function pollServer(serverId, managedUserIds, { refreshUsers = true } = {}) {
    const windowSeconds = activeWindowSeconds();
    const sessionsPromise = registry.request(
        serverId,
        `/Sessions?activeWithinSeconds=${encodeURIComponent(windowSeconds)}`,
        { timeoutMs: 10000, cacheTtlMs: 45000 }
    );
    const usersPromise = refreshUsers
        ? registry.request(serverId, '/Users', { timeoutMs: 10000 })
        : Promise.resolve(null);
    const [users, sessions] = await Promise.all([usersPromise, sessionsPromise]);
    if (refreshUsers && !Array.isArray(users)) throw new Error('Jellyfin users response was not an array');
    if (!Array.isArray(sessions)) throw new Error('Jellyfin sessions response was not an array');

    const activity = refreshUsers ? await persistUserActivity(serverId, users) : { observed: 0, updated: 0 };
    const playing = sessions.filter(session => session?.Id && session?.UserId && session?.NowPlayingItem);
    let managedStreams = 0;
    let transcodeStreams = 0;
    let directStreamStreams = 0;
    let directPlayStreams = 0;
    let pausedStreams = 0;

    for (const session of playing) {
        if (managedUserIds.has(String(session.UserId).toLowerCase())) managedStreams += 1;
        if (session?.PlayState?.IsPaused) pausedStreams += 1;
        const method = playbackMethod(session);
        if (method === 'transcode') transcodeStreams += 1;
        else if (method === 'directstream') directStreamStreams += 1;
        else if (method === 'directplay') directPlayStreams += 1;
    }

    const metrics = {
        totalUsers: refreshUsers ? users.length : await cachedTotalUsers(serverId),
        activeStreams: playing.length,
        managedStreams,
        transcodeStreams,
        directStreamStreams,
        directPlayStreams,
        pausedStreams,
        activityUpdates: activity.updated,
        usersRefreshed: refreshUsers
    };
    await persistSuccess(serverId, metrics);
    return metrics;
}

async function mapLimit(items, limit, worker) {
    if (!items.length) return [];
    const output = new Array(items.length);
    let cursor = 0;
    async function run() {
        for (;;) {
            const index = cursor++;
            if (index >= items.length) return;
            output[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, run));
    return output;
}

async function refreshAll(options = {}) {
    const rows = await inventory();
    const refreshUsers = options.refreshUsers !== false;
    const results = await mapLimit(rows, 3, async row => {
        try {
            const metrics = await pollServer(row.serverId, row.managedUserIds, { refreshUsers });
            return { serverId: row.serverId, ok: true, ...metrics };
        } catch (error) {
            try { await persistFailure(row.serverId, error); } catch (_) {}
            return { serverId: row.serverId, ok: false, error: String(error?.message || error) };
        }
    });
    return results;
}

async function listCached() {
    const result = await query(`
        SELECT server_id,total_users,active_streams,managed_streams,transcode_streams,
               direct_stream_streams,direct_play_streams,paused_streams,
               observed_at,last_error,error_at,updated_at
        FROM jellyfin_server_metrics
    `);
    return result.rows;
}

module.exports = {
    activeWindowSeconds,
    playbackMethod,
    parseJellyfinDate,
    userActivityDate,
    isNewerActivity,
    activityRows,
    persistUserActivity,
    refreshServerUserActivity,
    inventory,
    pollServer,
    refreshAll,
    listCached
};