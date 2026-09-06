'use strict';

const crypto = require('crypto');
const { query } = require('../db');
const registry = require('./registry');

function playbackMethod(session) {
  const method = String(session?.PlayState?.PlayMethod || '').toLowerCase();
  if (method === 'directplay') return 'directplay';
  if (method === 'directstream') return 'directstream';
  if (method === 'transcode' || session?.TranscodingInfo) return 'transcode';
  return 'unknown';
}

function playbackKey(serverId, session) {
  const playSessionId = session?.PlayState?.PlaySessionId || '';
  const itemId = session?.NowPlayingItem?.Id || '';
  return crypto
    .createHash('sha256')
    .update(`${serverId}|${session.Id}|${playSessionId}|${itemId}`)
    .digest('hex');
}

function administratorUsers(users) {
  const map = new Map();
  for (const user of Array.isArray(users) ? users : []) {
    if (!user?.Id || user?.Policy?.IsAdministrator !== true) continue;
    map.set(String(user.Id).toLowerCase(), {
      id: String(user.Id),
      name: String(user.Name || user.Id)
    });
  }
  return map;
}

async function managedUserIds(serverId) {
  const result = await query(`
    SELECT jellyfin_user_id
    FROM jellyfin_accounts
    WHERE server_id=$1
      AND jellyfin_user_id IS NOT NULL
      AND disabled=FALSE
      AND COALESCE(account_purpose,'jellyfin')<>'stremio_internal'
  `, [serverId]);
  return new Set(result.rows.map(row => String(row.jellyfin_user_id).toLowerCase()));
}

async function enabledServers() {
  const result = await query(`
    SELECT id,name
    FROM jellyfin_servers
    WHERE enabled=TRUE
    ORDER BY priority,name
  `);
  return result.rows;
}

function telemetrySession(serverId, session, user) {
  const item = session.NowPlayingItem || {};
  const state = session.PlayState || {};
  const transcodeReasons = Array.isArray(session?.TranscodingInfo?.TranscodeReasons)
    ? session.TranscodingInfo.TranscodeReasons
    : [];
  return {
    serverId: String(serverId),
    sessionId: String(session.Id),
    playbackKey: playbackKey(serverId, session),
    jellyfinUserId: user.id,
    playSessionId: state.PlaySessionId || null,
    itemId: item.Id || null,
    itemName: item.Name || null,
    itemType: item.Type || null,
    clientName: session.Client || null,
    deviceName: session.DeviceName || null,
    applicationVersion: session.ApplicationVersion || null,
    method: playbackMethod(session),
    transcodeReasons,
    isPaused: Boolean(state.IsPaused),
    positionTicks: Number.isFinite(Number(state.PositionTicks)) ? Number(state.PositionTicks) : null,
    lastActivityAt: session.LastActivityDate || null
  };
}

async function upsertSession(s) {
  const prior = await query(`
    SELECT playback_key
    FROM active_playback_sessions
    WHERE server_id=$1 AND jellyfin_session_id=$2
  `, [s.serverId, s.sessionId]);

  if (prior.rowCount && prior.rows[0].playback_key !== s.playbackKey) {
    await query(`
      UPDATE playback_history
      SET ended_at=COALESCE(ended_at,NOW()),
          ended_reason=COALESCE(ended_reason,'item_changed'),
          last_seen_at=NOW()
      WHERE server_id=$1 AND playback_key=$2
    `, [s.serverId, prior.rows[0].playback_key]);
  }

  await query(`
    INSERT INTO active_playback_sessions(
      server_id,jellyfin_session_id,playback_key,customer_id,jellyfin_account_id,jellyfin_user_id,
      play_session_id,item_id,item_name,item_type,client_name,device_name,application_version,
      playback_method,transcode_reasons,is_paused,position_ticks,last_activity_at,
      first_seen_at,last_seen_at,stream_limit,over_limit_confirmations
    ) VALUES(
      $1,$2,$3,NULL,NULL,$4,
      $5,$6,$7,$8,$9,$10,$11,
      $12,$13::jsonb,$14,$15,$16,
      NOW(),NOW(),NULL,0
    )
    ON CONFLICT(server_id,jellyfin_session_id) DO UPDATE SET
      playback_key=EXCLUDED.playback_key,
      customer_id=NULL,
      jellyfin_account_id=NULL,
      jellyfin_user_id=EXCLUDED.jellyfin_user_id,
      play_session_id=EXCLUDED.play_session_id,
      item_id=EXCLUDED.item_id,
      item_name=EXCLUDED.item_name,
      item_type=EXCLUDED.item_type,
      client_name=EXCLUDED.client_name,
      device_name=EXCLUDED.device_name,
      application_version=EXCLUDED.application_version,
      playback_method=EXCLUDED.playback_method,
      transcode_reasons=EXCLUDED.transcode_reasons,
      is_paused=EXCLUDED.is_paused,
      position_ticks=EXCLUDED.position_ticks,
      last_activity_at=EXCLUDED.last_activity_at,
      first_seen_at=CASE
        WHEN active_playback_sessions.playback_key<>EXCLUDED.playback_key THEN NOW()
        ELSE active_playback_sessions.first_seen_at
      END,
      last_seen_at=NOW(),
      stream_limit=NULL,
      over_limit_confirmations=0
  `, [
    s.serverId,s.sessionId,s.playbackKey,s.jellyfinUserId,
    s.playSessionId,s.itemId,s.itemName,s.itemType,s.clientName,s.deviceName,s.applicationVersion,
    s.method,JSON.stringify(s.transcodeReasons),s.isPaused,s.positionTicks,s.lastActivityAt
  ]);

  await query(`
    INSERT INTO playback_history(
      server_id,customer_id,jellyfin_account_id,jellyfin_user_id,playback_key,jellyfin_session_id,
      item_id,item_name,item_type,client_name,device_name,playback_method,transcode_reasons,
      started_at,last_seen_at
    ) VALUES($1,NULL,NULL,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,NOW(),NOW())
    ON CONFLICT(server_id,playback_key) DO UPDATE SET
      jellyfin_user_id=EXCLUDED.jellyfin_user_id,
      item_id=EXCLUDED.item_id,
      item_name=EXCLUDED.item_name,
      item_type=EXCLUDED.item_type,
      client_name=EXCLUDED.client_name,
      device_name=EXCLUDED.device_name,
      playback_method=EXCLUDED.playback_method,
      transcode_reasons=EXCLUDED.transcode_reasons,
      last_seen_at=NOW(),
      ended_at=NULL,
      ended_reason=NULL
  `, [
    s.serverId,s.jellyfinUserId,s.playbackKey,s.sessionId,s.itemId,s.itemName,s.itemType,
    s.clientName,s.deviceName,s.method,JSON.stringify(s.transcodeReasons)
  ]);
}

async function closeMissing(serverId, administratorIds, seenSessionIds) {
  if (!administratorIds.length) return 0;
  const result = await query(`
    SELECT jellyfin_session_id,playback_key
    FROM active_playback_sessions
    WHERE server_id=$1
      AND customer_id IS NULL
      AND jellyfin_account_id IS NULL
      AND LOWER(jellyfin_user_id)=ANY($2::text[])
  `, [serverId, administratorIds.map(id => String(id).toLowerCase())]);

  let closed = 0;
  for (const row of result.rows) {
    if (seenSessionIds.has(String(row.jellyfin_session_id))) continue;
    await query(`
      UPDATE playback_history
      SET ended_at=COALESCE(ended_at,NOW()),
          ended_reason=COALESCE(ended_reason,'session_ended'),
          last_seen_at=NOW()
      WHERE server_id=$1 AND playback_key=$2
    `, [serverId, row.playback_key]);
    await query(`
      DELETE FROM active_playback_sessions
      WHERE server_id=$1 AND jellyfin_session_id=$2
        AND customer_id IS NULL AND jellyfin_account_id IS NULL
    `, [serverId, row.jellyfin_session_id]);
    closed += 1;
  }
  return closed;
}

async function pollServer(server) {
  const serverId = String(server.id);
  const [users, sessions, managed] = await Promise.all([
    registry.request(serverId, '/Users', { timeoutMs: 10000, cacheTtlMs: 300000 }),
    registry.request(serverId, '/Sessions?activeWithinSeconds=120', { timeoutMs: 10000, cacheTtlMs: 5000 }),
    managedUserIds(serverId)
  ]);
  if (!Array.isArray(users)) throw new Error('Jellyfin users response was not an array');
  if (!Array.isArray(sessions)) throw new Error('Jellyfin sessions response was not an array');

  const admins = administratorUsers(users);
  const telemetryAdmins = new Map([...admins].filter(([id]) => !managed.has(id)));
  const seenSessionIds = new Set();
  let observed = 0;

  for (const session of sessions) {
    if (!session?.Id || !session?.UserId || !session?.NowPlayingItem) continue;
    const user = telemetryAdmins.get(String(session.UserId).toLowerCase());
    if (!user) continue;
    const normalized = telemetrySession(serverId, session, user);
    await upsertSession(normalized);
    seenSessionIds.add(normalized.sessionId);
    observed += 1;
  }

  const closed = await closeMissing(serverId, [...telemetryAdmins.keys()], seenSessionIds);
  return {
    serverId,
    serverName: server.name,
    administrators: telemetryAdmins.size,
    observed,
    closed
  };
}

async function runAdminPlaybackTelemetryCycle() {
  const servers = await enabledServers();
  const results = [];
  for (const server of servers) {
    try {
      results.push({ ok: true, ...(await pollServer(server)) });
    } catch (error) {
      results.push({
        ok: false,
        serverId: String(server.id),
        serverName: server.name,
        error: String(error?.message || error)
      });
    }
  }
  return {
    servers: results.length,
    observed: results.filter(row => row.ok).reduce((sum,row) => sum + Number(row.observed || 0), 0),
    failures: results.filter(row => !row.ok),
    results
  };
}

module.exports = {
  playbackMethod,
  playbackKey,
  administratorUsers,
  telemetrySession,
  managedUserIds,
  pollServer,
  runAdminPlaybackTelemetryCycle
};
