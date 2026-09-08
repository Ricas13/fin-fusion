'use strict';

const { query } = require('../db');

const DAY_MS = 24 * 60 * 60 * 1000;
const SIMPLE_PRESETS = new Set(['7', '30', '90', '6m', '1y', 'ytd']);
const CUSTOM_RE = /^custom:(\d{4}-\d{2}-\d{2}):(\d{4}-\d{2}-\d{2})$/;

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isoDay(date) {
  return new Date(date).toISOString().slice(0, 10);
}

function parseIsoDay(value) {
  const raw = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const date = new Date(`${raw}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && isoDay(date) === raw ? date : null;
}

function normalizeDays(value) {
  const raw = String(value == null ? '' : value).trim().toLowerCase();
  if (SIMPLE_PRESETS.has(raw)) return raw === '7' || raw === '30' || raw === '90' ? Number(raw) : raw;
  if (raw === '182') return '6m';
  if (raw === '365') return '1y';
  const custom = raw.match(CUSTOM_RE);
  if (custom && parseIsoDay(custom[1]) && parseIsoDay(custom[2]) && custom[1] <= custom[2]) return raw;
  return 30;
}

function shiftMonths(date, months) {
  const result = new Date(date);
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0)).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

function shiftYears(date, years) {
  const result = new Date(date);
  const month = result.getUTCMonth();
  result.setUTCFullYear(result.getUTCFullYear() + years);
  if (result.getUTCMonth() !== month) result.setUTCDate(0);
  return result;
}

function rangeLabelForCustom(start, endInclusive) {
  const formatter = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  return `${formatter.format(start)} – ${formatter.format(endInclusive)}`;
}

function resolveRange(input, nowInput = new Date()) {
  const now = new Date(nowInput);
  const normalized = normalizeDays(input);
  let key = String(normalized);
  let token = String(normalized);
  let start;
  let end = new Date(now);
  let label;
  let fromDate;
  let toDate;

  if (typeof normalized === 'number') {
    start = new Date(end.getTime() - normalized * DAY_MS);
    label = `Last ${normalized} days`;
  } else if (normalized === '6m') {
    start = shiftMonths(end, -6);
    label = 'Last 6 months';
  } else if (normalized === '1y') {
    start = shiftYears(end, -1);
    label = 'Last 1 year';
  } else if (normalized === 'ytd') {
    start = new Date(Date.UTC(end.getUTCFullYear(), 0, 1, 0, 0, 0, 0));
    label = 'Year to date';
  } else {
    const custom = String(normalized).match(CUSTOM_RE);
    const customStart = custom ? parseIsoDay(custom[1]) : null;
    const customEndDay = custom ? parseIsoDay(custom[2]) : null;
    if (!customStart || !customEndDay) return resolveRange(30, now);
    const exclusiveEnd = new Date(customEndDay.getTime() + DAY_MS);
    start = customStart;
    end = exclusiveEnd > now ? new Date(now) : exclusiveEnd;
    if (!(start < end)) return resolveRange(30, now);
    key = 'custom';
    fromDate = custom[1];
    toDate = custom[2];
    token = `custom:${fromDate}:${toDate}`;
    label = rangeLabelForCustom(customStart, customEndDay);
  }

  const durationMs = Math.max(1, end.getTime() - start.getTime());
  const previousEnd = new Date(start);
  const previousStart = new Date(previousEnd.getTime() - durationMs);
  return {
    key,
    token,
    start,
    end,
    previousStart,
    previousEnd,
    days: Math.max(1, Math.ceil(durationMs / DAY_MS)),
    rangeLabel: label,
    fromDate: fromDate || isoDay(start),
    toDate: toDate || isoDay(new Date(Math.min(now.getTime(), end.getTime()) - 1))
  };
}

function comparison(current, previous, inverse = false) {
  const now = toNumber(current);
  const before = toNumber(previous);
  if (before <= 0) {
    if (now <= 0) return { direction: 'flat', tone: 'neutral', percent: 0, label: 'No change' };
    return { direction: 'up', tone: inverse ? 'bad' : 'good', percent: null, label: 'New activity' };
  }
  const raw = ((now - before) / before) * 100;
  const direction = Math.abs(raw) < 0.05 ? 'flat' : raw > 0 ? 'up' : 'down';
  const positive = direction === 'up';
  return {
    direction,
    tone: direction === 'flat' ? 'neutral' : inverse ? (positive ? 'bad' : 'good') : (positive ? 'good' : 'bad'),
    percent: Math.round(Math.abs(raw)),
    label: direction === 'flat' ? 'No change' : `${positive ? 'Up' : 'Down'} ${Math.round(Math.abs(raw))}%`
  };
}

function boundsParams(range) {
  return [range.start, range.end];
}

async function periodMetrics(input, legacyOffsetDays = 0) {
  let range;
  if (typeof input === 'number' && legacyOffsetDays) {
    const end = new Date(Date.now() - legacyOffsetDays * DAY_MS);
    range = resolveRange(input, end);
  } else {
    range = input && input.start && input.end ? input : resolveRange(input);
  }
  const result = await query(`
    WITH bounds AS (SELECT $1::timestamptz AS period_start, $2::timestamptz AS period_end),
    intersecting AS (
      SELECT ph.*, GREATEST(ph.started_at,b.period_start) AS clipped_start,
             LEAST(COALESCE(ph.ended_at,ph.last_seen_at,b.period_end),b.period_end) AS clipped_end
      FROM playback_history ph CROSS JOIN bounds b
      WHERE ph.started_at < b.period_end
        AND COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at) > b.period_start
    ),
    started AS (
      SELECT ph.*, LEAST(COALESCE(ph.ended_at,ph.last_seen_at,b.period_end),b.period_end) AS session_end
      FROM playback_history ph CROSS JOIN bounds b
      WHERE ph.started_at >= b.period_start AND ph.started_at < b.period_end
    ),
    concurrency_events AS (
      SELECT clipped_start AS at,1::int AS delta FROM intersecting WHERE clipped_end>clipped_start
      UNION ALL
      SELECT clipped_end AS at,-1::int AS delta FROM intersecting WHERE clipped_end>clipped_start
    ),
    concurrency_points AS (SELECT at,SUM(delta)::int AS delta FROM concurrency_events GROUP BY at),
    concurrency_running AS (SELECT SUM(delta) OVER(ORDER BY at ROWS UNBOUNDED PRECEDING)::int AS concurrent FROM concurrency_points)
    SELECT
      (SELECT COUNT(*)::int FROM started) AS total_plays,
      (SELECT COUNT(DISTINCT customer_id)::int FROM started WHERE customer_id IS NOT NULL) AS unique_users,
      COALESCE((SELECT SUM(EXTRACT(EPOCH FROM(clipped_end-clipped_start)))::bigint FROM intersecting WHERE clipped_end>clipped_start),0) AS total_watch_seconds,
      COALESCE((SELECT MAX(concurrent)::int FROM concurrency_running),0) AS peak_concurrent_streams,
      COALESCE((SELECT (COUNT(*) FILTER(WHERE playback_method='transcode'))::numeric*100/NULLIF(COUNT(*),0) FROM started),0) AS transcode_rate,
      COALESCE((SELECT AVG(EXTRACT(EPOCH FROM(session_end-started_at)))::bigint FROM started WHERE session_end>started_at),0) AS average_session_seconds
  `, boundsParams(range));
  const row = result.rows?.[0] || {};
  return {
    totalPlays: toNumber(row.total_plays), uniqueUsers: toNumber(row.unique_users),
    totalWatchSeconds: toNumber(row.total_watch_seconds), peakConcurrentStreams: toNumber(row.peak_concurrent_streams),
    transcodeRate: toNumber(row.transcode_rate), averageSessionSeconds: toNumber(row.average_session_seconds)
  };
}

async function topUsersByWatchTime(range) {
  const result = await query(`
    WITH bounds AS (SELECT $1::timestamptz AS period_start,$2::timestamptz AS period_end), rows AS (
      SELECT ph.customer_id,COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name,
             GREATEST(ph.started_at,b.period_start) AS clipped_start,
             LEAST(COALESCE(ph.ended_at,ph.last_seen_at,b.period_end),b.period_end) AS clipped_end
      FROM playback_history ph CROSS JOIN bounds b
      LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id
      LEFT JOIN customers c ON c.id=ph.customer_id LEFT JOIN app_users au ON au.id=c.user_id
      WHERE ph.customer_id IS NOT NULL AND ph.started_at<b.period_end
        AND COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)>b.period_start)
    SELECT customer_id,customer_name,SUM(EXTRACT(EPOCH FROM(clipped_end-clipped_start)))::bigint AS watch_seconds
    FROM rows WHERE clipped_end>clipped_start GROUP BY customer_id,customer_name
    ORDER BY watch_seconds DESC,customer_name ASC LIMIT 20
  `, boundsParams(range));
  return result.rows.map(row => ({ ...row, watch_seconds: toNumber(row.watch_seconds) }));
}

async function topUsersByItemType(range, itemType) {
  const result = await query(`
    SELECT ph.customer_id,COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name,
           COUNT(DISTINCT COALESCE(NULLIF(ph.item_id,''),NULLIF(ph.item_name,''),ph.playback_key))::int AS item_count
    FROM playback_history ph
    LEFT JOIN jellyfin_accounts ja ON ja.id=ph.jellyfin_account_id
    LEFT JOIN customers c ON c.id=ph.customer_id LEFT JOIN app_users au ON au.id=c.user_id
    WHERE ph.customer_id IS NOT NULL AND LOWER(COALESCE(ph.item_type,''))=LOWER($3)
      AND ph.started_at >= $1::timestamptz AND ph.started_at < $2::timestamptz
    GROUP BY ph.customer_id,customer_name ORDER BY item_count DESC,customer_name ASC LIMIT 20
  `, [range.start, range.end, itemType]);
  return result.rows.map(row => ({ ...row, item_count: toNumber(row.item_count) }));
}

async function topDimension(range, column) {
  const allowed = column === 'client_name' ? 'client_name' : 'device_name';
  const result = await query(`
    SELECT COALESCE(NULLIF(TRIM(${allowed}),''),'Unknown') AS name,COUNT(*)::int AS plays
    FROM playback_history WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
    GROUP BY 1 ORDER BY plays DESC,name ASC LIMIT 20
  `, boundsParams(range));
  return result.rows.map(row => ({ ...row, plays: toNumber(row.plays) }));
}

async function topContent(range) {
  const result = await query(`
    WITH bounds AS (SELECT $1::timestamptz AS period_start,$2::timestamptz AS period_end), rows AS (
      SELECT COALESCE(NULLIF(ph.item_name,''),'Unknown item') AS title,COALESCE(NULLIF(ph.item_type,''),'Unknown') AS item_type,
             GREATEST(ph.started_at,b.period_start) AS clipped_start,
             LEAST(COALESCE(ph.ended_at,ph.last_seen_at,b.period_end),b.period_end) AS clipped_end
      FROM playback_history ph CROSS JOIN bounds b
      WHERE ph.started_at<b.period_end AND COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)>b.period_start)
    SELECT title,item_type,SUM(EXTRACT(EPOCH FROM(clipped_end-clipped_start)))::bigint AS watch_seconds
    FROM rows WHERE clipped_end>clipped_start GROUP BY title,item_type ORDER BY watch_seconds DESC,title ASC LIMIT 20
  `, boundsParams(range));
  return result.rows.map(row => ({ ...row, watch_seconds: toNumber(row.watch_seconds) }));
}

async function topUsersByConcurrency(range) {
  const result = await query(`
    WITH bounds AS (SELECT $1::timestamptz AS period_start,$2::timestamptz AS period_end), sessions AS (
      SELECT ph.customer_id,GREATEST(ph.started_at,b.period_start) AS clipped_start,
             LEAST(COALESCE(ph.ended_at,ph.last_seen_at,b.period_end),b.period_end) AS clipped_end
      FROM playback_history ph CROSS JOIN bounds b
      WHERE ph.customer_id IS NOT NULL AND ph.started_at<b.period_end
        AND COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)>b.period_start),
    events AS (
      SELECT customer_id,clipped_start AS at,1::int AS delta FROM sessions WHERE clipped_end>clipped_start
      UNION ALL SELECT customer_id,clipped_end AS at,-1::int AS delta FROM sessions WHERE clipped_end>clipped_start),
    points AS (SELECT customer_id,at,SUM(delta)::int AS delta FROM events GROUP BY customer_id,at),
    running AS (SELECT customer_id,SUM(delta) OVER(PARTITION BY customer_id ORDER BY at ROWS UNBOUNDED PRECEDING)::int AS concurrent FROM points),
    peaks AS (SELECT customer_id,MAX(concurrent)::int AS peak_concurrent FROM running GROUP BY customer_id)
    SELECT p.customer_id,COALESCE(NULLIF(c.display_name,''),au.username,ja.jellyfin_username,'Customer') AS customer_name,p.peak_concurrent
    FROM peaks p LEFT JOIN customers c ON c.id=p.customer_id LEFT JOIN app_users au ON au.id=c.user_id
    LEFT JOIN LATERAL (SELECT jellyfin_username FROM jellyfin_accounts WHERE customer_id=p.customer_id ORDER BY updated_at DESC NULLS LAST,created_at DESC NULLS LAST LIMIT 1) ja ON TRUE
    ORDER BY p.peak_concurrent DESC,customer_name ASC LIMIT 20
  `, boundsParams(range));
  return result.rows.map(row => ({ ...row, peak_concurrent: toNumber(row.peak_concurrent) }));
}

function trendGrain(range) {
  if (range.days <= 120) return { trunc: 'day', step: '1 day' };
  if (range.days <= 730) return { trunc: 'week', step: '1 week' };
  return { trunc: 'month', step: '1 month' };
}

async function usageTrend(range) {
  const grain = trendGrain(range);
  const result = await query(`
    WITH buckets AS (
      SELECT generate_series(date_trunc('${grain.trunc}',$1::timestamptz),date_trunc('${grain.trunc}',$2::timestamptz - INTERVAL '1 microsecond'),INTERVAL '${grain.step}') AS bucket
    ), started AS (
      SELECT date_trunc('${grain.trunc}',started_at) AS bucket,COUNT(*)::int AS plays,
             COALESCE(
               SUM(
                 GREATEST(
                   0,
                   EXTRACT(EPOCH FROM (
                     LEAST(COALESCE(ended_at,last_seen_at,$2::timestamptz),$2::timestamptz) - started_at
                   ))
                 )
               ),
               0
             )::bigint AS watch_seconds
      FROM playback_history WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz GROUP BY 1)
    SELECT b.bucket AS day,COALESCE(s.plays,0)::int AS plays,COALESCE(s.watch_seconds,0)::bigint AS watch_seconds
    FROM buckets b LEFT JOIN started s ON s.bucket=b.bucket ORDER BY b.bucket ASC
  `, boundsParams(range));
  return result.rows.map(row => ({ day: row.day, plays: toNumber(row.plays), watch_seconds: toNumber(row.watch_seconds) }));
}

async function playbackMethods(range) {
  const result = await query(`
    SELECT COALESCE(NULLIF(LOWER(playback_method),''),'unknown') AS method,COUNT(*)::int AS plays
    FROM playback_history WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz
    GROUP BY 1 ORDER BY plays DESC,method ASC
  `, boundsParams(range));
  const total = result.rows.reduce((sum, row) => sum + toNumber(row.plays), 0);
  return result.rows.map(row => { const plays = toNumber(row.plays); return { method: row.method, plays, percent: total ? plays * 100 / total : 0 }; });
}

async function sessionLengthBuckets(range) {
  const result = await query(`
    WITH sessions AS (
      SELECT GREATEST(0,EXTRACT(EPOCH FROM(LEAST(COALESCE(ended_at,last_seen_at,$2::timestamptz),$2::timestamptz)-started_at))) AS seconds
      FROM playback_history WHERE started_at >= $1::timestamptz AND started_at < $2::timestamptz)
    SELECT bucket,COUNT(*)::int AS sessions FROM (
      SELECT CASE WHEN seconds<300 THEN 'Under 5m' WHEN seconds<900 THEN '5–15m' WHEN seconds<1800 THEN '15–30m' WHEN seconds<3600 THEN '30–60m' WHEN seconds<7200 THEN '1–2h' ELSE '2h+' END AS bucket,
             CASE WHEN seconds<300 THEN 1 WHEN seconds<900 THEN 2 WHEN seconds<1800 THEN 3 WHEN seconds<3600 THEN 4 WHEN seconds<7200 THEN 5 ELSE 6 END AS bucket_order
      FROM sessions) grouped GROUP BY bucket,bucket_order ORDER BY bucket_order
  `, boundsParams(range));
  return result.rows.map(row => ({ bucket: row.bucket, sessions: toNumber(row.sessions) }));
}

async function load(input) {
  const range = input && input.start && input.end ? input : resolveRange(input);
  const previousRange = { ...range, start: range.previousStart, end: range.previousEnd };
  const [metrics,previousMetrics,topUsersWatchTime,topUsersMovies,topUsersEpisodes,topDevices,topPlatforms,topContentRows,topConcurrentUsers,trends,methods,sessionLengths] = await Promise.all([
    periodMetrics(range),periodMetrics(previousRange),topUsersByWatchTime(range),topUsersByItemType(range,'Movie'),topUsersByItemType(range,'Episode'),
    topDimension(range,'device_name'),topDimension(range,'client_name'),topContent(range),topUsersByConcurrency(range),usageTrend(range),playbackMethods(range),sessionLengthBuckets(range)
  ]);
  return {
    days: range.days, rangeKey: range.key, rangeToken: range.token, rangeLabel: range.rangeLabel,
    fromDate: range.fromDate, toDate: range.toDate,
    metrics,
    comparisons: {
      totalPlays: comparison(metrics.totalPlays,previousMetrics.totalPlays),
      uniqueUsers: comparison(metrics.uniqueUsers,previousMetrics.uniqueUsers),
      totalWatchSeconds: comparison(metrics.totalWatchSeconds,previousMetrics.totalWatchSeconds),
      peakConcurrentStreams: comparison(metrics.peakConcurrentStreams,previousMetrics.peakConcurrentStreams),
      transcodeRate: comparison(metrics.transcodeRate,previousMetrics.transcodeRate,true),
      averageSessionSeconds: comparison(metrics.averageSessionSeconds,previousMetrics.averageSessionSeconds)
    },
    topUsersWatchTime,topUsersMovies,topUsersEpisodes,topDevices,topPlatforms,topContent:topContentRows,topConcurrentUsers,trends,methods,sessionLengths,dataUsageAvailable:false
  };
}

module.exports = { normalizeDays, resolveRange, comparison, periodMetrics, load };
