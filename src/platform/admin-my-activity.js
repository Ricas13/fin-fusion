'use strict';

const express = require('express');
const { query } = require('../db');
const registry = require('../jellyfin/registry');
const runtimeSettings = require('./runtime-settings');
const customerActivity = require('./customer-activity');

const {
  RANGE_OPTIONS,
  rangeOption,
  rangeStart,
  previousRange,
  heatmap,
  aggregatePlatforms
} = customerActivity;

function requireAdminSession(req, res, next) {
  if (req.session?.authUserId && req.session?.authRole === 'admin') return next();
  return res.redirect('/login?session=expired');
}

function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function percentChange(current, previous) {
  const a = number(current), b = number(previous);
  if (b <= 0) return a > 0 ? 100 : 0;
  return Math.round(((a - b) / b) * 100);
}

function durationSql(alias = 'ph') {
  return `LEAST(43200,GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(${alias}.ended_at,${alias}.last_seen_at)-${alias}.started_at))))`;
}

function utcDayStart(value) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function fillDailyTimeline(rows, startAt, now) {
  const byDay = new Map(rows.map(row => [utcDayStart(row.bucket).toISOString().slice(0, 10), row]));
  const out = [];
  for (let day = utcDayStart(startAt); day <= utcDayStart(now); day = new Date(day.getTime() + 86400000)) {
    const key = day.toISOString().slice(0, 10), row = byDay.get(key) || {};
    out.push({ bucket: new Date(day), plays: number(row.plays), hours: Math.round((number(row.seconds) / 3600) * 10) / 10 });
  }
  return out;
}

function formatHour(hour) {
  const h = ((Number(hour) % 24) + 24) % 24;
  if (h === 0) return '12am';
  if (h === 12) return '12pm';
  return h < 12 ? `${h}am` : `${h - 12}pm`;
}

function peakWindow(hourRows) {
  const byHour = Array(24).fill(0);
  for (const row of hourRows) byHour[number(row.hour)] += number(row.seconds);
  let bestStart = 0, best = -1;
  for (let start = 0; start <= 20; start += 1) {
    const total = byHour.slice(start, start + 4).reduce((sum, value) => sum + value, 0);
    if (total > best) { best = total; bestStart = start; }
  }
  return best > 0 ? `${formatHour(bestStart)}–${formatHour((bestStart + 4) % 24)}` : 'No peak yet';
}

function platformLabel(device, client) {
  const text = `${device || ''} ${client || ''}`.toLowerCase();
  if (/shield/.test(text)) return 'NVIDIA Shield';
  if (/apple tv|appletv/.test(text)) return 'Apple TV';
  if (/iphone|ipad|ios/.test(text)) return 'iOS (iPhone/iPad)';
  if (/fire tv|firetv|aft/.test(text)) return 'Amazon Fire TV';
  if (/roku/.test(text)) return 'Roku';
  if (/webos|\blg\b/.test(text)) return 'LG TV';
  if (/tizen|samsung/.test(text)) return 'Samsung TV';
  if (/android tv|google tv/.test(text)) return 'Android TV';
  if (/android/.test(text)) return 'Android (Mobile)';
  if (/chrome|firefox|safari|edge|browser|web client/.test(text)) return 'Web Browser';
  return String(device || client || 'Other device');
}

function identityScope(identities, alias = 'ph') {
  const params = [];
  const clauses = identities.map(identity => {
    params.push(identity.serverId, identity.userId);
    const serverIndex = params.length - 1;
    const userIndex = params.length;
    return `(${alias}.server_id=$${serverIndex}::uuid AND (
      LOWER(${alias}.jellyfin_user_id)=LOWER($${userIndex}::text)
      OR EXISTS (
        SELECT 1
        FROM jellyfin_accounts ja_identity
        WHERE ja_identity.id=${alias}.jellyfin_account_id
          AND LOWER(ja_identity.jellyfin_user_id)=LOWER($${userIndex}::text)
      )
    ))`;
  });
  return { sql: clauses.length ? `(${clauses.join(' OR ')})` : 'FALSE', params };
}

async function scopedQuery(identities, sqlBuilder, extraParams = []) {
  const scope = identityScope(identities, 'ph');
  return query(sqlBuilder(scope.sql, scope.params.length), [...scope.params, ...extraParams]);
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
        user?.Id && user?.Policy?.IsAdministrator === true &&
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
      const rows = await registry.request(identity.serverId, '/Sessions', { timeoutMs: 7000, cacheTtlMs: 5000 });
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

function metadataItems(payload) {
  return Array.isArray(payload) ? payload : Array.isArray(payload?.Items) ? payload.Items : Array.isArray(payload?.items) ? payload.items : [];
}

function publicItemImage(publicUrl, itemId) {
  if (!publicUrl || !itemId) return null;
  try {
    const base = new URL(String(publicUrl));
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) return null;
    return `${base.toString().replace(/\/$/, '')}/Items/${encodeURIComponent(String(itemId))}/Images/Primary?maxHeight=96&quality=82`;
  } catch {
    return null;
  }
}

async function metadataForRows(rows) {
  const groups = new Map();
  for (const row of rows) {
    if (!row.server_id || !row.item_id || !row.jellyfin_user_id) continue;
    const key = `${row.server_id}|${row.jellyfin_user_id}`;
    if (!groups.has(key)) groups.set(key, { serverId: row.server_id, userId: row.jellyfin_user_id, ids: new Set() });
    groups.get(key).ids.add(String(row.item_id));
  }
  const metadata = new Map();
  await Promise.all([...groups.values()].map(async group => {
    const ids = [...group.ids].slice(0, 40);
    if (!ids.length) return;
    const fields = 'Genres,CommunityRating,ProductionYear,ParentIndexNumber,IndexNumber,SeriesName,RunTimeTicks,UserData';
    const endpoint = `/Users/${encodeURIComponent(group.userId)}/Items?Ids=${encodeURIComponent(ids.join(','))}&Fields=${encodeURIComponent(fields)}&Limit=${ids.length}`;
    try {
      const payload = await registry.request(group.serverId, endpoint, { timeoutMs: 5000, cacheTtlMs: 60000 });
      for (const item of metadataItems(payload)) {
        if (item?.Id) metadata.set(`${group.serverId}|${String(item.Id).toLowerCase()}`, item);
      }
    } catch (error) {
      console.warn('Admin activity metadata enrichment unavailable:', { serverId: group.serverId, error: error.message });
    }
  }));
  return metadata;
}

function rowMetadata(row, metadata) {
  return row?.item_id ? metadata.get(`${row.server_id}|${String(row.item_id).toLowerCase()}`) || null : null;
}

function genreSummary(rows, metadata) {
  const totals = new Map();
  for (const row of rows) {
    const meta = rowMetadata(row, metadata), genres = Array.isArray(meta?.Genres) ? meta.Genres.map(String).filter(Boolean).slice(0, 5) : [];
    if (!genres.length) continue;
    const share = number(row.seconds) / genres.length;
    for (const genre of genres) totals.set(genre, (totals.get(genre) || 0) + share);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  const sum = Math.max(1, sorted.reduce((total, row) => total + row[1], 0));
  return sorted.map(([name, seconds]) => ({ name, percent: Math.max(1, Math.round((seconds / sum) * 100)) }));
}

function averageRating(rows, metadata) {
  const seen = new Set(), ratings = [];
  for (const row of rows) {
    const key = `${row.server_id}|${row.item_id || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const rating = number(rowMetadata(row, metadata)?.CommunityRating);
    if (rating > 0 && rating <= 10) ratings.push(rating);
  }
  return ratings.length ? Math.round((ratings.reduce((sum, value) => sum + value, 0) / ratings.length) * 10) / 10 : null;
}

function recentWatching(rows, metadata) {
  return rows.slice(0, 5).map(row => {
    const meta = rowMetadata(row, metadata), episode = String(row.item_type || '').toLowerCase() === 'episode';
    const season = Number(meta?.ParentIndexNumber), episodeNo = Number(meta?.IndexNumber), series = meta?.SeriesName || null, year = meta?.ProductionYear || null;
    const runtimeTicks = number(meta?.RunTimeTicks), userProgress = number(meta?.UserData?.PlayedPercentage), durationSeconds = number(row.duration_seconds);
    let progress = null;
    if (userProgress > 0) progress = Math.max(0, Math.min(100, Math.round(userProgress)));
    else if (runtimeTicks > 0 && durationSeconds > 0) progress = Math.max(1, Math.min(100, Math.round((durationSeconds / (runtimeTicks / 10000000)) * 100)));
    const episodeBits = [];
    if (Number.isFinite(season)) episodeBits.push(`S${season}`);
    if (Number.isFinite(episodeNo)) episodeBits.push(`E${episodeNo}`);
    if (row.item_name) episodeBits.push(row.item_name);
    return {
      title: episode && series ? series : (row.item_name || 'Unknown item'),
      subtitle: episode ? episodeBits.join(' · ') : [row.item_type || 'Media', year].filter(Boolean).join(' · '),
      lastSeenAt: row.last_seen_at || row.started_at,
      progress,
      imageUrl: publicItemImage(row.public_url, row.item_id)
    };
  });
}

function summaryFrom(row) {
  const seconds = number(row?.seconds), sessions = number(row?.sessions);
  return {
    watchHours: Math.round((seconds / 3600) * 10) / 10,
    watchSeconds: seconds,
    titlesWatched: number(row?.titles_watched),
    episodesWatched: number(row?.episodes_watched),
    sessions,
    activeDays: number(row?.active_days),
    averageMinutes: sessions ? Math.round((seconds / 60) / sessions) : 0,
    lastPlayback: row?.last_playback || null
  };
}

async function activityData(username, rawRange) {
  const now = new Date(), range = rangeOption(rawRange), startAt = rangeStart(range, now), previous = previousRange(startAt, now), duration = durationSql('ph');
  const { identities, failures } = await jellyfinAdminIdentities(username);

  if (!identities.length) {
    return {
      identities,
      identityFailures: failures,
      active: [],
      activity: [],
      insights: {
        range,
        rangeOptions: RANGE_OPTIONS,
        summary: { ...summaryFrom({}), averageRating: null },
        comparison: { watchTime: 0, titles: 0, episodes: 0, label: range.key === '30d' ? 'vs previous 30 days' : 'vs previous period', available: Boolean(previous.start) },
        genres: [], platforms: [], timeline: [], heatmap: heatmap([]), recent: [], peakTime: 'No peak yet',
        insightCards: { watchTrend: 0, favoriteGenre: null, peakTime: 'No peak yet', deviceCount: 0 }
      }
    };
  }

  const since = startAt ? startAt.toISOString() : null;
  const summarySql = (scope, count) => `
    SELECT COUNT(*)::int sessions,
           COALESCE(SUM(${duration}),0) seconds,
           COUNT(DISTINCT COALESCE(NULLIF(ph.item_id,''),NULLIF(ph.item_name,''),ph.playback_key))::int titles_watched,
           COUNT(*) FILTER (WHERE LOWER(COALESCE(ph.item_type,''))='episode')::int episodes_watched,
           COUNT(DISTINCT DATE(ph.started_at))::int active_days,
           MAX(COALESCE(ph.last_seen_at,ph.started_at)) last_playback
    FROM playback_history ph
    WHERE ${scope}
      AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
      AND ($${count + 2}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)<$${count + 2}::timestamptz)
  `;

  const previousStart = previous.start ? previous.start.toISOString() : null;
  const previousEnd = previous.end ? previous.end.toISOString() : null;
  const bucket = range.bucket;

  const [summaryResult, previousResult, topResult, deviceResult, timelineResult, heatResult, recentResult, activityResult, live] = await Promise.all([
    scopedQuery(identities, summarySql, [since, null]),
    previous.start ? scopedQuery(identities, summarySql, [previousStart, previousEnd]) : Promise.resolve({ rows: [{}] }),
    scopedQuery(identities, (scope, count) => `
      SELECT ph.server_id,COALESCE(ph.jellyfin_user_id,ja.jellyfin_user_id) jellyfin_user_id,
             ph.item_id,ph.item_name,ph.item_type,js.public_url,
             COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds
      FROM playback_history ph
      JOIN jellyfin_servers js ON js.id=ph.server_id
      LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id
      WHERE ${scope}
        AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
      GROUP BY ph.server_id,COALESCE(ph.jellyfin_user_id,ja.jellyfin_user_id),ph.item_id,ph.item_name,ph.item_type,js.public_url
      ORDER BY seconds DESC,plays DESC LIMIT 24
    `, [since]),
    scopedQuery(identities, (scope, count) => `
      SELECT ph.device_name,ph.client_name,COUNT(*)::int plays,COALESCE(SUM(${duration}),0) seconds
      FROM playback_history ph
      WHERE ${scope}
        AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
      GROUP BY ph.device_name,ph.client_name ORDER BY seconds DESC LIMIT 50
    `, [since]),
    scopedQuery(identities, (scope, count) => `
      SELECT date_trunc('${bucket}',ph.started_at) bucket,COALESCE(SUM(${duration}),0) seconds,COUNT(*)::int plays
      FROM playback_history ph
      WHERE ${scope}
        AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
      GROUP BY 1 ORDER BY 1 ASC
    `, [since]),
    scopedQuery(identities, (scope, count) => `
      SELECT EXTRACT(ISODOW FROM ph.started_at)::int AS "day",EXTRACT(HOUR FROM ph.started_at)::int AS "hour",COALESCE(SUM(${duration}),0) seconds
      FROM playback_history ph
      WHERE ${scope}
        AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
      GROUP BY 1,2 ORDER BY 1,2
    `, [since]),
    scopedQuery(identities, (scope, count) => `
      SELECT * FROM (
        SELECT DISTINCT ON (ph.server_id,COALESCE(NULLIF(ph.item_id,''),ph.playback_key))
               ph.server_id,COALESCE(ph.jellyfin_user_id,ja.jellyfin_user_id) jellyfin_user_id,
               ph.item_id,ph.item_name,ph.item_type,ph.started_at,ph.last_seen_at,ph.ended_at,
               ${duration} duration_seconds,js.public_url
        FROM playback_history ph
        JOIN jellyfin_servers js ON js.id=ph.server_id
        LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id
        WHERE ${scope}
          AND ($${count + 1}::timestamptz IS NULL OR COALESCE(ph.last_seen_at,ph.started_at)>=$${count + 1}::timestamptz)
        ORDER BY ph.server_id,COALESCE(NULLIF(ph.item_id,''),ph.playback_key),COALESCE(ph.last_seen_at,ph.started_at) DESC
      ) recent
      ORDER BY COALESCE(last_seen_at,started_at) DESC LIMIT 20
    `, [since]),
    scopedQuery(identities, (scope) => `
      SELECT ph.started_at,ph.ended_at,ph.last_seen_at,ph.item_name,ph.item_type,ph.client_name,ph.device_name,ph.playback_method,js.name server_name
      FROM playback_history ph
      JOIN jellyfin_servers js ON js.id=ph.server_id
      WHERE ${scope}
      ORDER BY COALESCE(ph.last_seen_at,ph.started_at) DESC LIMIT 100
    `),
    liveAdminSessions(identities)
  ]);

  recentResult.rows.sort((a, b) => new Date(b.last_seen_at || b.started_at) - new Date(a.last_seen_at || a.started_at));
  const metadata = await metadataForRows([...topResult.rows, ...recentResult.rows]);
  const genres = genreSummary(topResult.rows, metadata), rating = averageRating(topResult.rows, metadata);
  const summary = summaryFrom(summaryResult.rows[0] || {}), prior = summaryFrom(previousResult.rows[0] || {}), platforms = aggregatePlatforms(deviceResult.rows);
  const hourRows = [];
  for (const row of heatResult.rows) {
    const hour = number(row.hour), entry = hourRows.find(item => item.hour === hour);
    if (entry) entry.seconds += number(row.seconds);
    else hourRows.push({ hour, seconds: number(row.seconds) });
  }
  let timeline = timelineResult.rows.map(row => ({ bucket: row.bucket, plays: number(row.plays), hours: Math.round((number(row.seconds) / 3600) * 10) / 10 }));
  if (range.bucket === 'day' && startAt) timeline = fillDailyTimeline(timelineResult.rows, startAt, now);
  const peakTime = peakWindow(hourRows);

  return {
    identities,
    identityFailures: [...failures, ...live.failures],
    active: live.sessions,
    activity: activityResult.rows,
    insights: {
      range,
      rangeOptions: RANGE_OPTIONS,
      summary: { ...summary, averageRating: rating },
      comparison: {
        watchTime: percentChange(summary.watchSeconds, prior.watchSeconds),
        titles: percentChange(summary.titlesWatched, prior.titlesWatched),
        episodes: percentChange(summary.episodesWatched, prior.episodesWatched),
        label: range.key === '30d' ? 'vs previous 30 days' : 'vs previous period',
        available: Boolean(previous.start)
      },
      genres,
      platforms,
      timeline,
      heatmap: heatmap(heatResult.rows),
      recent: recentWatching(recentResult.rows, metadata),
      peakTime,
      insightCards: {
        watchTrend: percentChange(summary.watchSeconds, prior.watchSeconds),
        favoriteGenre: genres[0]?.name || null,
        peakTime,
        deviceCount: new Set(deviceResult.rows.map(row => platformLabel(row.device_name, row.client_name))).size
      }
    }
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
  identityScope,
  jellyfinAdminIdentities,
  liveAdminSessions,
  activityData,
  createAdminMyActivityRouter
};
