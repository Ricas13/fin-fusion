'use strict';

const crypto = require('crypto');
const { query, transaction } = require('../db');
const registry = require('./registry');

function playbackMethod(value) {
    const method = String(value || '').toLowerCase();
    if (method === 'directplay') return 'directplay';
    if (method === 'directstream') return 'directstream';
    if (method === 'transcode') return 'transcode';
    return 'unknown';
}

function eventTime(payload) {
    const value = payload?.UtcTimestamp || payload?.Timestamp || null;
    const parsed = value ? new Date(value) : new Date();
    return Number.isFinite(parsed.getTime()) ? parsed : new Date();
}

function positionTicks(payload) {
    const value = Number(payload?.PlaybackPositionTicks ?? payload?.PositionTicks);
    return Number.isFinite(value) && value >= 0 ? Math.floor(value) : null;
}

function pollPlaybackKey(serverId, session) {
    const playSessionId = session?.PlayState?.PlaySessionId || '';
    const itemId = session?.NowPlayingItem?.Id || '';
    return crypto.createHash('sha256').update(`${serverId}|${session.Id}|${playSessionId}|${itemId}`).digest('hex');
}

function syntheticIdentity(serverId, payload) {
    const natural = [serverId,payload?.UserId || '',payload?.DeviceId || '',payload?.DeviceName || '',payload?.ClientName || '',payload?.ItemId || ''].join('|');
    const sessionId = `webhook:${crypto.createHash('sha256').update(natural).digest('hex').slice(0, 32)}`;
    return { sessionId, playbackKey: crypto.createHash('sha256').update(`${natural}|${eventTime(payload).toISOString()}`).digest('hex'), playSessionId: null };
}

function sameText(a, b) {
    if (!a || !b) return true;
    return String(a).toLowerCase() === String(b).toLowerCase();
}

async function accountFor(serverId, userId) {
    if (!userId) return null;
    const result = await query(`
        SELECT ja.id,ja.customer_id,ja.server_id,ja.jellyfin_user_id
        FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE ja.server_id=$1 AND lower(ja.jellyfin_user_id)=lower($2)
          AND js.enabled=TRUE AND ja.disabled=FALSE
          AND COALESCE(ja.account_purpose,'jellyfin')<>'stremio_internal'
        ORDER BY CASE WHEN ja.access_lane='free' THEN 0 ELSE 1 END,ja.created_at
        LIMIT 1
    `, [serverId, String(userId)]);
    return result.rows[0] || null;
}

async function liveSessionIdentity(serverId, payload) {
    try {
        const sessions = await registry.request(serverId, '/Sessions?activeWithinSeconds=120');
        if (!Array.isArray(sessions)) return null;
        const userId = String(payload?.UserId || '').toLowerCase();
        const itemId = String(payload?.ItemId || '');
        const match = sessions.find(session =>
            session?.Id && session?.NowPlayingItem &&
            String(session.UserId || '').toLowerCase() === userId &&
            (!itemId || String(session.NowPlayingItem.Id || '') === itemId) &&
            sameText(payload?.DeviceName, session.DeviceName) &&
            sameText(payload?.ClientName, session.Client)
        );
        if (!match) return null;
        return {
            sessionId: String(match.Id),
            playbackKey: pollPlaybackKey(serverId, match),
            playSessionId: match?.PlayState?.PlaySessionId || null
        };
    } catch (_) {
        return null;
    }
}

async function matchingActive(serverId, account, payload, explicitSessionId = null) {
    if (explicitSessionId) {
        const exact = await query(`
            SELECT * FROM active_playback_sessions
            WHERE server_id=$1 AND jellyfin_session_id=$2
            LIMIT 1
        `, [serverId, explicitSessionId]);
        if (exact.rowCount) return exact.rows[0];
    }
    const result = await query(`
        SELECT * FROM active_playback_sessions
        WHERE server_id=$1 AND jellyfin_account_id=$2
          AND ($3::text IS NULL OR item_id=$3)
          AND ($4::text IS NULL OR device_name=$4)
          AND ($5::text IS NULL OR client_name=$5)
        ORDER BY last_seen_at DESC
        LIMIT 1
    `, [serverId,account.id,payload?.ItemId || null,payload?.DeviceName || null,payload?.ClientName || null]);
    return result.rows[0] || null;
}

function startedAt(payload, at) {
    const ticks = positionTicks(payload);
    if (ticks == null) return at;
    const elapsedMs = Math.max(0, Math.floor(ticks / 10000));
    return new Date(Math.max(0, at.getTime() - elapsedMs));
}

async function touchAccount(account, at, client = null) {
    const runner = client || { query };
    await runner.query(`
        UPDATE jellyfin_accounts
        SET last_activity_at=GREATEST(COALESCE(last_activity_at,$2),$2)
        WHERE id=$1
    `, [account.id, at]);
}

async function upsertStart(serverId, account, payload, at) {
    const live = await liveSessionIdentity(serverId, payload);
    const identity = live || syntheticIdentity(serverId, payload);
    const existing = await matchingActive(serverId, account, payload, identity.sessionId);
    const sessionId = existing?.jellyfin_session_id || identity.sessionId;
    const playbackKey = existing?.playback_key || identity.playbackKey;
    const firstSeen = startedAt(payload, at);
    const method = playbackMethod(payload?.PlayMethod);
    const ticks = positionTicks(payload);
    await transaction(async client => {
        await client.query(`
            INSERT INTO active_playback_sessions(
                server_id,jellyfin_session_id,playback_key,customer_id,jellyfin_account_id,jellyfin_user_id,
                play_session_id,item_id,item_name,item_type,client_name,device_name,playback_method,
                is_paused,position_ticks,last_activity_at,first_seen_at,last_seen_at,over_limit_confirmations
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,0)
            ON CONFLICT(server_id,jellyfin_session_id) DO UPDATE SET
                customer_id=EXCLUDED.customer_id,jellyfin_account_id=EXCLUDED.jellyfin_account_id,
                jellyfin_user_id=EXCLUDED.jellyfin_user_id,play_session_id=COALESCE(EXCLUDED.play_session_id,active_playback_sessions.play_session_id),
                item_id=COALESCE(EXCLUDED.item_id,active_playback_sessions.item_id),item_name=COALESCE(EXCLUDED.item_name,active_playback_sessions.item_name),
                item_type=COALESCE(EXCLUDED.item_type,active_playback_sessions.item_type),client_name=COALESCE(EXCLUDED.client_name,active_playback_sessions.client_name),
                device_name=COALESCE(EXCLUDED.device_name,active_playback_sessions.device_name),playback_method=EXCLUDED.playback_method,
                is_paused=EXCLUDED.is_paused,position_ticks=COALESCE(EXCLUDED.position_ticks,active_playback_sessions.position_ticks),
                last_activity_at=GREATEST(COALESCE(active_playback_sessions.last_activity_at,EXCLUDED.last_activity_at),EXCLUDED.last_activity_at),
                first_seen_at=LEAST(active_playback_sessions.first_seen_at,EXCLUDED.first_seen_at),last_seen_at=GREATEST(active_playback_sessions.last_seen_at,EXCLUDED.last_seen_at)
        `, [serverId,sessionId,playbackKey,account.customer_id,account.id,account.jellyfin_user_id,identity.playSessionId,
            payload?.ItemId || null,payload?.Name || payload?.ItemName || null,payload?.ItemType || null,payload?.ClientName || null,
            payload?.DeviceName || null,method,Boolean(payload?.IsPaused),ticks,at,firstSeen,at]);
        await client.query(`
            INSERT INTO playback_history(
                server_id,customer_id,jellyfin_account_id,playback_key,jellyfin_session_id,item_id,item_name,item_type,
                client_name,device_name,playback_method,started_at,last_seen_at
            ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
            ON CONFLICT(server_id,playback_key) DO UPDATE SET
                last_seen_at=GREATEST(playback_history.last_seen_at,EXCLUDED.last_seen_at),
                playback_method=EXCLUDED.playback_method
        `, [serverId,account.customer_id,account.id,playbackKey,sessionId,payload?.ItemId || null,payload?.Name || payload?.ItemName || null,
            payload?.ItemType || null,payload?.ClientName || null,payload?.DeviceName || null,method,firstSeen,at]);
        await touchAccount(account, at, client);
    });
    return { recorded: true, playbackKey, sessionId, source: live ? 'webhook+session' : 'webhook' };
}

async function progress(serverId, account, payload, at) {
    let active = await matchingActive(serverId, account, payload, payload?.SessionId || null);
    if (!active) {
        await upsertStart(serverId, account, payload, at);
        active = await matchingActive(serverId, account, payload, payload?.SessionId || null);
    }
    if (!active) return { recorded: false, reason: 'active_session_unresolved' };
    const ticks = positionTicks(payload);
    await transaction(async client => {
        await client.query(`
            UPDATE active_playback_sessions SET
                is_paused=$3,position_ticks=COALESCE($4,position_ticks),last_activity_at=GREATEST(COALESCE(last_activity_at,$5),$5),last_seen_at=GREATEST(last_seen_at,$5)
            WHERE server_id=$1 AND jellyfin_session_id=$2
        `, [serverId,active.jellyfin_session_id,Boolean(payload?.IsPaused),ticks,at]);
        await client.query(`UPDATE playback_history SET last_seen_at=GREATEST(last_seen_at,$3) WHERE server_id=$1 AND playback_key=$2`, [serverId,active.playback_key,at]);
        await touchAccount(account, at, client);
    });
    return { recorded: true, playbackKey: active.playback_key, sessionId: active.jellyfin_session_id };
}

async function stop(serverId, account, payload, at) {
    const active = await matchingActive(serverId, account, payload, payload?.SessionId || null);
    if (!active) return { recorded: false, reason: 'active_session_not_found' };
    await transaction(async client => {
        await client.query(`
            UPDATE playback_history
            SET ended_at=COALESCE(ended_at,$3),last_seen_at=GREATEST(last_seen_at,$3),ended_reason=COALESCE(ended_reason,'webhook_stop')
            WHERE server_id=$1 AND playback_key=$2
        `, [serverId,active.playback_key,at]);
        await client.query(`DELETE FROM active_playback_sessions WHERE server_id=$1 AND jellyfin_session_id=$2`, [serverId,active.jellyfin_session_id]);
        await touchAccount(account, at, client);
    });
    return { recorded: true, playbackKey: active.playback_key, sessionId: active.jellyfin_session_id };
}

async function ingest(serverId, payload = {}) {
    const type = String(payload.NotificationType || payload.Event || '').toLowerCase();
    if (!['playbackstart','playbackprogress','playbackstop'].includes(type)) return { recorded: false, reason: 'event_ignored' };
    const account = await accountFor(serverId, payload.UserId);
    if (!account) return { recorded: false, reason: 'unmanaged_user' };
    const at = eventTime(payload);
    if (type === 'playbackstart') return upsertStart(serverId, account, payload, at);
    if (type === 'playbackprogress') return progress(serverId, account, payload, at);
    return stop(serverId, account, payload, at);
}

module.exports = { ingest, pollPlaybackKey, syntheticIdentity, eventTime, positionTicks };
