'use strict';

const express = require('express');
const { query } = require('../db');
const registry = require('../jellyfin/registry');
const runtimeSettings = require('./runtime-settings');

const RANGES = Object.freeze([
  { key: '7d', label: '7 days', days: 7, bucket: 'day' },
  { key: '30d', label: '30 days', days: 30, bucket: 'day' },
  { key: '90d', label: '3 months', days: 90, bucket: 'day' },
  { key: '365d', label: '1 year', days: 365, bucket: 'week' },
  { key: 'all', label: 'All time', days: null, bucket: 'month' }
]);

function requireAdminSession(req, res, next) {
  if (req.session?.authUserId && req.session?.authRole === 'admin') return next();
  return res.redirect('/login?session=expired');
}

function rangeOption(raw) {
  return RANGES.find(item => item.key === String(raw || '')) || RANGES[1];
}

function startFor(range) {
  if (!range.days) return null;
  const start = new Date();
  start.setUTCHours(0, 0, 0, 0);
  start.setUTCDate(start.getUTCDate() - (range.days - 1));
  return start;
}

function durationSql(alias = 'ph') {
  return `LEAST(43200,GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(${alias}.ended_at,${alias}.last_seen_at)-${alias}.started_at))))`;
}

function identityScope(identities, alias = 'ph') {
  const params = [];
  const clauses = identities.map(identity => {
    params.push(identity.serverId, identity.userId);
    const serverIndex = params.length - 1;
    const userIndex = params.length;
    return `(${alias}.server_id=$${serverIndex}::uuid AND LOWER(${alias}.jellyfin_user_id)=LOWER($${userIndex}::text))`;
  });
  return { sql: clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE', params };
}

async function jellyfinAdminIdentities(username) {
  const servers = await query(`
    SELECT id,name
    FROM jellyfin_servers
    WHERE enabled=TRUE
    ORDER BY priority,name
  `);
  const identities = [];
  const failures = [];

  await Promise.all(servers.rows.map(async server => {
    try {
      const users = await registry.request(String(server.id), '/Users', { timeoutMs: 7000, cacheTtlMs: 300000 });
      if (!Array.isArray(users)) throw new Error('Jellyfin users response was not an array');
      const matched = users.find(user =>
        user?.Id &&
        user?.Policy?.IsAdministrator === true &&
        String(user.Name || '').toLowerCase() === String(username || '').toLowerCase()
      );
      if (matched) identities.push({
        serverId: String(server.id),
        serverName: String(server.name || 'Jellyfin'),
        userId: String(matched.Id),
        username: String(matched.Name || username)
      });
    } catch (error) {
      failures.push({ serverId: String(server.id), serverName: server.name, error: String(error?.message || error) });
    }
  }));

  identities.sort((a, b) => a.serverName.localeCompare(b.serverName));
  return { identities, failures };
}

async function liveAdminSessions(identities) {
  const sessions = [];
  const failures = [];
  await Promise.all(identities.map(async identity => {
    try {
      const rows = await registry.request(
        identity.serverId,
        '/Sessions?activeWithinSeconds=120',
        { timeoutMs: 7000, cacheTtlMs: 5000 }
      );
      if (!Array.isArray(rows)) throw new Error('Jellyfin sessions response was not an array');
      for (const session of rows) {
        if (!session?.Id || !session?.NowPlayingItem) continue;
        if (String(session.UserId || '').toLowerCase() !== identity.userId.toLowerCase()) continue;
        const method = String(session?.PlayState?.PlayMethod || '').toLowerCase();
        sessions.push({
          item_name: session.NowPlayingItem.Name || null,
          item_type: session.NowPlayingItem.Type || null,
          device_name: session.DeviceName || null,
          client_name: session.Client || null,
          playback_method: method === 'directplay' ? 'directplay' : method === 'directstream' ? 'directstream' : (method === 'transcode' || session.TranscodingInfo) ? 'transcode' : 'unknown',
          is_paused: Boolean(session?.PlayState?.IsPaused),
          first_seen_at: session.LastActivityDate || null,
          last_seen_at: session.LastActivityDate || null,
          server_name: identity.serverName
        });
      }
    } catch (error) {
      failures.push({ serverId: identity.serverId, serverName: identity.serverName, error: String(error?.message || error) });
    }
  }));
  return { sessions, failures };
}

async function scopedQuery(identities, sqlBuilder, extraParams = []) {
  const scope = identityScope(identities, 'ph');
  return query(sqlBuilder(scope.sql, scope.params.length), [...scope.params, ...extraParams]);
}

async function activityData(username, rawRange) {
  const range = rangeOption(rawRange);
  const startAt = startFor(range);
  const { identities, failures } = await jellyfinAdminIdentities(username);
  if (!identities.length) {
    return {
      range, ranges: RANGES, identities, identityFailures: failures,
      summary: { seconds: 0, sessions: 0, titles: 0, episodes: 0, activeDays: 0, lastPlayback: null },
      timeline: [], topTitles: [], devices: [], methods: [], servers: [], recent: [], active: []
    };
  }

  const since = startAt ? startAt.toISOString() : null;
  const duration = durationSql('ph');
  const summaryPromise = scopedQuery(identities, (scope, count) => `
    SELECT COUNT(*)::int sessions,
           COALESCE(SUM(${duration}),0)::double precision seconds,
           COUNT(DISTINCT COALESCE(NULLIF(ph.item_id,''),NULLIF(ph.item_name,''),ph.playback_key))::int titles,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(ph.item_type,''))='episode')::int episodes,
           COUNT(DISTINCT DATE(ph.started_at))::int active_days,
           MAX(COALESCE(ph.last_seen_at,ph.started_at)) last_playback
    FROM playback_history ph
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
  `, [since]);

  const timelinePromise = scopedQuery(identities, (scope, count) => `
    SELECT date_trunc('${range.bucket}',ph.started_at) bucket,
           COALESCE(SUM(${duration}),0)::double precision seconds,
           COUNT(*)::int plays
    FROM playback_history ph
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
    GROUP BY 1 ORDER BY 1 ASC
  `, [since]);

  const topTitlesPromise = scopedQuery(identities, (scope, count) => `
    SELECT COALESCE(NULLIF(ph.item_name,''),'Unknown item') item_name,
           COALESCE(NULLIF(ph.item_type,''),'Media') item_type,
           COUNT(*)::int plays,
           COALESCE(SUM(${duration}),0)::double precision seconds,
           MAX(COALESCE(ph.last_seen_at,ph.started_at)) last_seen_at
    FROM playback_history ph
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
    GROUP BY 1,2 ORDER BY seconds DESC,plays DESC LIMIT 10
  `, [since]);

  const devicesPromise = scopedQuery(identities, (scope, count) => `
    SELECT COALESCE(NULLIF(ph.device_name,''),NULLIF(ph.client_name,''),'Unknown device') device,
           COUNT(*)::int plays,
           COALESCE(SUM(${duration}),0)::double precision seconds
    FROM playback_history ph
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
    GROUP BY 1 ORDER BY seconds DESC LIMIT 8
  `, [since]);

  const methodsPromise = scopedQuery(identities, (scope, count) => `
    SELECT COALESCE(NULLIF(ph.playback_method,''),'unknown') method,
           COUNT(*)::int plays,
           COALESCE(SUM(${duration}),0)::double precision seconds
    FROM playback_history ph
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
    GROUP BY 1 ORDER BY seconds DESC
  `, [since]);

  const serversPromise = scopedQuery(identities, (scope, count) => `
    SELECT js.name server_name,COUNT(*)::int plays,
           COALESCE(SUM(${duration}),0)::double precision seconds
    FROM playback_history ph
    JOIN jellyfin_servers js ON js.id=ph.server_id
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
    GROUP BY js.id,js.name ORDER BY seconds DESC
  `, [since]);

  const recentPromise = scopedQuery(identities, (scope, count) => `
    SELECT ph.item_name,ph.item_type,ph.device_name,ph.client_name,ph.playback_method,
           ph.started_at,ph.last_seen_at,ph.ended_at,js.name server_name,
           ${duration}::double precision seconds
    FROM playback_history ph
    JOIN jellyfin_servers js ON js.id=ph.server_id
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
    ORDER BY COALESCE(ph.last_seen_at,ph.started_at) DESC LIMIT 20
  `, [since]);

  const livePromise = liveAdminSessions(identities);
  const [summaryResult,timelineResult,topTitlesResult,devicesResult,methodsResult,serversResult,recentResult,live] = await Promise.all([
    summaryPromise,timelinePromise,topTitlesPromise,devicesPromise,methodsPromise,serversPromise,recentPromise,livePromise
  ]);

  const summaryRow = summaryResult.rows[0] || {};
  return {
    range,
    ranges: RANGES,
    identities,
    identityFailures: [...failures, ...live.failures],
    summary: {
      seconds: Number(summaryRow.seconds || 0),
      sessions: Number(summaryRow.sessions || 0),
      titles: Number(summaryRow.titles || 0),
      episodes: Number(summaryRow.episodes || 0),
      activeDays: Number(summaryRow.active_days || 0),
      lastPlayback: summaryRow.last_playback || null
    },
    timeline: timelineResult.rows.map(row => ({ ...row, seconds: Number(row.seconds || 0), plays: Number(row.plays || 0) })),
    topTitles: topTitlesResult.rows.map(row => ({ ...row, seconds: Number(row.seconds || 0), plays: Number(row.plays || 0) })),
    devices: devicesResult.rows.map(row => ({ ...row, seconds: Number(row.seconds || 0), plays: Number(row.plays || 0) })),
    methods: methodsResult.rows.map(row => ({ ...row, seconds: Number(row.seconds || 0), plays: Number(row.plays || 0) })),
    servers: serversResult.rows.map(row => ({ ...row, seconds: Number(row.seconds || 0), plays: Number(row.plays || 0) })),
    recent: recentResult.rows.map(row => ({ ...row, seconds: Number(row.seconds || 0) })),
    active: live.sessions
  };
}

function createAdminMyActivityRouter() {
  const router = express.Router();
  router.get('/admin/activity/me', requireAdminSession, async (req, res, next) => {
    try {
      await runtimeSettings.ensureLoaded();
      const username = String(req.session.authUsername || '');
      const data = await activityData(username, req.query.range);
      res.setHeader('Cache-Control', 'no-store, private, max-age=0');
      res.setHeader('Pragma', 'no-cache');
      return res.render('admin/my-activity', {
        siteName: runtimeSettings.siteName(),
        staffUsername: username,
        ...data
      });
    } catch (error) {
      return next(error);
    }
  });
  return router;
}

module.exports = {
  RANGES,
  rangeOption,
  startFor,
  identityScope,
  jellyfinAdminIdentities,
  liveAdminSessions,
  activityData,
  createAdminMyActivityRouter
};
