'use strict';

const { query } = require('../db');

const ALLOWED_RANGES = new Set([7, 30, 90]);

function normalizeDays(value) {
  const parsed = Number.parseInt(String(value || ''), 10);
  return ALLOWED_RANGES.has(parsed) ? parsed : 30;
}

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
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
  const tone = direction === 'flat' ? 'neutral' : inverse ? (positive ? 'bad' : 'good') : (positive ? 'good' : 'bad');
  return {
    direction,
    tone,
    percent: Math.round(Math.abs(raw)),
    label: direction === 'flat' ? 'No change' : `${positive ? 'Up' : 'Down'} ${Math.round(Math.abs(raw))}%`
  };
}

async function periodMetrics(days, offsetDays = 0) {
  const result = await query(`
    WITH bounds AS (
      SELECT
        NOW() - (($1::int + $2::int) * INTERVAL '1 day') AS period_start,
        NOW() - ($2::int * INTERVAL '1 day') AS period_end
    ),
    intersecting AS (
      SELECT
        ph.*,
        GREATEST(ph.started_at, b.period_start) AS clipped_start,
        LEAST(COALESCE(ph.ended_at, ph.last_seen_at, b.period_end), b.period_end) AS clipped_end
      FROM playback_history ph
      CROSS JOIN bounds b
      WHERE ph.started_at < b.period_end
        AND COALESCE(ph.ended_at, ph.last_seen_at, ph.started_at) > b.period_start
    ),
    started AS (
      SELECT
        ph.*,
        LEAST(COALESCE(ph.ended_at, ph.last_seen_at, b.period_end), b.period_end) AS session_end
      FROM playback_history ph
      CROSS JOIN bounds b
      WHERE ph.started_at >= b.period_start
        AND ph.started_at < b.period_end
    ),
    concurrency_events AS (
      SELECT clipped_start AS at, 1::int AS delta
      FROM intersecting
      WHERE clipped_end > clipped_start
      UNION ALL
      SELECT clipped_end AS at, -1::int AS delta
      FROM intersecting
      WHERE clipped_end > clipped_start
    ),
    concurrency_points AS (
      SELECT at, SUM(delta)::int AS delta
      FROM concurrency_events
      GROUP BY at
    ),
    concurrency_running AS (
      SELECT SUM(delta) OVER (ORDER BY at ROWS UNBOUNDED PRECEDING)::int AS concurrent
      FROM concurrency_points
    )
    SELECT
      (SELECT COUNT(*)::int FROM started) AS total_plays,
      (SELECT COUNT(DISTINCT customer_id)::int FROM started WHERE customer_id IS NOT NULL) AS unique_users,
      COALESCE((
        SELECT SUM(EXTRACT(EPOCH FROM (clipped_end - clipped_start)))::bigint
        FROM intersecting
        WHERE clipped_end > clipped_start
      ), 0) AS total_watch_seconds,
      COALESCE((SELECT MAX(concurrent)::int FROM concurrency_running), 0) AS peak_concurrent_streams,
      COALESCE((
        SELECT (COUNT(*) FILTER (WHERE playback_method = 'transcode'))::numeric * 100 / NULLIF(COUNT(*), 0)
        FROM started
      ), 0) AS transcode_rate,
      COALESCE((
        SELECT AVG(EXTRACT(EPOCH FROM (session_end - started_at)))::bigint
        FROM started
        WHERE session_end > started_at
      ), 0) AS average_session_seconds
  `, [days, offsetDays]);

  const row = result.rows?.[0] || {};
  return {
    totalPlays: toNumber(row.total_plays),
    uniqueUsers: toNumber(row.unique_users),
    totalWatchSeconds: toNumber(row.total_watch_seconds),
    peakConcurrentStreams: toNumber(row.peak_concurrent_streams),
    transcodeRate: toNumber(row.transcode_rate),
    averageSessionSeconds: toNumber(row.average_session_seconds)
  };
}

async function topUsersByWatchTime(days) {
  const result = await query(`
    WITH bounds AS (
      SELECT NOW() - ($1::int * INTERVAL '1 day') AS period_start, NOW() AS period_end
    ),
    rows AS (
      SELECT
        ph.customer_id,
        COALESCE(NULLIF(c.display_name, ''), au.username, ja.jellyfin_username, 'Customer') AS customer_name,
        GREATEST(ph.started_at, b.period_start) AS clipped_start,
        LEAST(COALESCE(ph.ended_at, ph.last_seen_at, b.period_end), b.period_end) AS clipped_end
      FROM playback_history ph
      CROSS JOIN bounds b
      LEFT JOIN jellyfin_accounts ja ON ja.id = ph.jellyfin_account_id
      LEFT JOIN customers c ON c.id = ph.customer_id
      LEFT JOIN app_users au ON au.id = c.user_id
      WHERE ph.customer_id IS NOT NULL
        AND ph.started_at < b.period_end
        AND COALESCE(ph.ended_at, ph.last_seen_at, ph.started_at) > b.period_start
    )
    SELECT customer_id, customer_name,
           SUM(EXTRACT(EPOCH FROM (clipped_end - clipped_start)))::bigint AS watch_seconds
    FROM rows
    WHERE clipped_end > clipped_start
    GROUP BY customer_id, customer_name
    ORDER BY watch_seconds DESC, customer_name ASC
    LIMIT 20
  `, [days]);
  return result.rows.map(row => ({ ...row, watch_seconds: toNumber(row.watch_seconds) }));
}

async function topUsersByItemType(days, itemType) {
  const result = await query(`
    WITH rows AS (
      SELECT
        ph.customer_id,
        COALESCE(NULLIF(c.display_name, ''), au.username, ja.jellyfin_username, 'Customer') AS customer_name,
        COALESCE(NULLIF(ph.item_id, ''), NULLIF(ph.item_name, ''), ph.playback_key) AS item_key
      FROM playback_history ph
      LEFT JOIN jellyfin_accounts ja ON ja.id = ph.jellyfin_account_id
      LEFT JOIN customers c ON c.id = ph.customer_id
      LEFT JOIN app_users au ON au.id = c.user_id
      WHERE ph.customer_id IS NOT NULL
        AND LOWER(COALESCE(ph.item_type, '')) = LOWER($2)
        AND ph.started_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND ph.started_at < NOW()
    )
    SELECT customer_id, customer_name, COUNT(DISTINCT item_key)::int AS item_count
    FROM rows
    GROUP BY customer_id, customer_name
    ORDER BY item_count DESC, customer_name ASC
    LIMIT 20
  `, [days, itemType]);
  return result.rows.map(row => ({ ...row, item_count: toNumber(row.item_count) }));
}

async function topDimension(days, column) {
  const allowed = column === 'client_name' ? 'client_name' : 'device_name';
  const result = await query(`
    SELECT COALESCE(NULLIF(TRIM(${allowed}), ''), 'Unknown') AS name, COUNT(*)::int AS plays
    FROM playback_history
    WHERE started_at >= NOW() - ($1::int * INTERVAL '1 day')
      AND started_at < NOW()
    GROUP BY 1
    ORDER BY plays DESC, name ASC
    LIMIT 20
  `, [days]);
  return result.rows.map(row => ({ ...row, plays: toNumber(row.plays) }));
}

async function topContent(days) {
  const result = await query(`
    WITH bounds AS (
      SELECT NOW() - ($1::int * INTERVAL '1 day') AS period_start, NOW() AS period_end
    ),
    rows AS (
      SELECT
        COALESCE(NULLIF(ph.item_name, ''), 'Unknown item') AS title,
        COALESCE(NULLIF(ph.item_type, ''), 'Unknown') AS item_type,
        GREATEST(ph.started_at, b.period_start) AS clipped_start,
        LEAST(COALESCE(ph.ended_at, ph.last_seen_at, b.period_end), b.period_end) AS clipped_end
      FROM playback_history ph
      CROSS JOIN bounds b
      WHERE ph.started_at < b.period_end
        AND COALESCE(ph.ended_at, ph.last_seen_at, ph.started_at) > b.period_start
    )
    SELECT title, item_type,
           SUM(EXTRACT(EPOCH FROM (clipped_end - clipped_start)))::bigint AS watch_seconds
    FROM rows
    WHERE clipped_end > clipped_start
    GROUP BY title, item_type
    ORDER BY watch_seconds DESC, title ASC
    LIMIT 20
  `, [days]);
  return result.rows.map(row => ({ ...row, watch_seconds: toNumber(row.watch_seconds) }));
}

async function topUsersByConcurrency(days) {
  const result = await query(`
    WITH bounds AS (
      SELECT NOW() - ($1::int * INTERVAL '1 day') AS period_start, NOW() AS period_end
    ),
    sessions AS (
      SELECT
        ph.customer_id,
        GREATEST(ph.started_at, b.period_start) AS clipped_start,
        LEAST(COALESCE(ph.ended_at, ph.last_seen_at, b.period_end), b.period_end) AS clipped_end
      FROM playback_history ph
      CROSS JOIN bounds b
      WHERE ph.customer_id IS NOT NULL
        AND ph.started_at < b.period_end
        AND COALESCE(ph.ended_at, ph.last_seen_at, ph.started_at) > b.period_start
    ),
    events AS (
      SELECT customer_id, clipped_start AS at, 1::int AS delta FROM sessions WHERE clipped_end > clipped_start
      UNION ALL
      SELECT customer_id, clipped_end AS at, -1::int AS delta FROM sessions WHERE clipped_end > clipped_start
    ),
    points AS (
      SELECT customer_id, at, SUM(delta)::int AS delta
      FROM events
      GROUP BY customer_id, at
    ),
    running AS (
      SELECT customer_id, SUM(delta) OVER (PARTITION BY customer_id ORDER BY at ROWS UNBOUNDED PRECEDING)::int AS concurrent
      FROM points
    ),
    peaks AS (
      SELECT customer_id, MAX(concurrent)::int AS peak_concurrent
      FROM running
      GROUP BY customer_id
    )
    SELECT p.customer_id,
           COALESCE(NULLIF(c.display_name, ''), au.username, ja.jellyfin_username, 'Customer') AS customer_name,
           p.peak_concurrent
    FROM peaks p
    LEFT JOIN customers c ON c.id = p.customer_id
    LEFT JOIN app_users au ON au.id = c.user_id
    LEFT JOIN LATERAL (
      SELECT jellyfin_username
      FROM jellyfin_accounts
      WHERE customer_id = p.customer_id
      ORDER BY updated_at DESC NULLS LAST, created_at DESC NULLS LAST
      LIMIT 1
    ) ja ON TRUE
    ORDER BY p.peak_concurrent DESC, customer_name ASC
    LIMIT 20
  `, [days]);
  return result.rows.map(row => ({ ...row, peak_concurrent: toNumber(row.peak_concurrent) }));
}

async function usageTrend(days) {
  const result = await query(`
    WITH days AS (
      SELECT generate_series(
        CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day'),
        CURRENT_DATE,
        INTERVAL '1 day'
      )::date AS day
    ),
    started AS (
      SELECT
        started_at::date AS day,
        COUNT(*)::int AS plays,
        COALESCE(SUM(EXTRACT(EPOCH FROM (
          GREATEST(started_at, LEAST(COALESCE(ended_at, last_seen_at, NOW()), NOW())) - started_at
        ))), 0)::bigint AS watch_seconds
      FROM playback_history
      WHERE started_at >= CURRENT_DATE - (($1::int - 1) * INTERVAL '1 day')
        AND started_at < NOW()
      GROUP BY started_at::date
    )
    SELECT d.day, COALESCE(s.plays, 0)::int AS plays, COALESCE(s.watch_seconds, 0)::bigint AS watch_seconds
    FROM days d
    LEFT JOIN started s ON s.day = d.day
    ORDER BY d.day ASC
  `, [days]);
  return result.rows.map(row => ({ day: row.day, plays: toNumber(row.plays), watch_seconds: toNumber(row.watch_seconds) }));
}

async function playbackMethods(days) {
  const result = await query(`
    SELECT COALESCE(NULLIF(LOWER(playback_method), ''), 'unknown') AS method, COUNT(*)::int AS plays
    FROM playback_history
    WHERE started_at >= NOW() - ($1::int * INTERVAL '1 day')
      AND started_at < NOW()
    GROUP BY 1
    ORDER BY plays DESC, method ASC
  `, [days]);
  const total = result.rows.reduce((sum, row) => sum + toNumber(row.plays), 0);
  return result.rows.map(row => {
    const plays = toNumber(row.plays);
    return { method: row.method, plays, percent: total ? (plays / total) * 100 : 0 };
  });
}

async function sessionLengthBuckets(days) {
  const result = await query(`
    WITH sessions AS (
      SELECT GREATEST(0, EXTRACT(EPOCH FROM (
        LEAST(COALESCE(ended_at, last_seen_at, NOW()), NOW()) - started_at
      ))) AS seconds
      FROM playback_history
      WHERE started_at >= NOW() - ($1::int * INTERVAL '1 day')
        AND started_at < NOW()
    )
    SELECT bucket, COUNT(*)::int AS sessions
    FROM (
      SELECT CASE
        WHEN seconds < 300 THEN 'Under 5m'
        WHEN seconds < 900 THEN '5–15m'
        WHEN seconds < 1800 THEN '15–30m'
        WHEN seconds < 3600 THEN '30–60m'
        WHEN seconds < 7200 THEN '1–2h'
        ELSE '2h+'
      END AS bucket,
      CASE
        WHEN seconds < 300 THEN 1
        WHEN seconds < 900 THEN 2
        WHEN seconds < 1800 THEN 3
        WHEN seconds < 3600 THEN 4
        WHEN seconds < 7200 THEN 5
        ELSE 6
      END AS bucket_order
      FROM sessions
    ) grouped
    GROUP BY bucket, bucket_order
    ORDER BY bucket_order
  `, [days]);
  return result.rows.map(row => ({ bucket: row.bucket, sessions: toNumber(row.sessions) }));
}

async function load(daysInput) {
  const days = normalizeDays(daysInput);
  const [
    metrics,
    previousMetrics,
    topUsersWatchTime,
    topUsersMovies,
    topUsersEpisodes,
    topDevices,
    topPlatforms,
    topContentRows,
    topConcurrentUsers,
    trends,
    methods,
    sessionLengths
  ] = await Promise.all([
    periodMetrics(days, 0),
    periodMetrics(days, days),
    topUsersByWatchTime(days),
    topUsersByItemType(days, 'Movie'),
    topUsersByItemType(days, 'Episode'),
    topDimension(days, 'device_name'),
    topDimension(days, 'client_name'),
    topContent(days),
    topUsersByConcurrency(days),
    usageTrend(days),
    playbackMethods(days),
    sessionLengthBuckets(days)
  ]);

  return {
    days,
    rangeLabel: `Last ${days} days`,
    metrics,
    comparisons: {
      totalPlays: comparison(metrics.totalPlays, previousMetrics.totalPlays),
      uniqueUsers: comparison(metrics.uniqueUsers, previousMetrics.uniqueUsers),
      totalWatchSeconds: comparison(metrics.totalWatchSeconds, previousMetrics.totalWatchSeconds),
      peakConcurrentStreams: comparison(metrics.peakConcurrentStreams, previousMetrics.peakConcurrentStreams),
      transcodeRate: comparison(metrics.transcodeRate, previousMetrics.transcodeRate, true),
      averageSessionSeconds: comparison(metrics.averageSessionSeconds, previousMetrics.averageSessionSeconds)
    },
    topUsersWatchTime,
    topUsersMovies,
    topUsersEpisodes,
    topDevices,
    topPlatforms,
    topContent: topContentRows,
    topConcurrentUsers,
    trends,
    methods,
    sessionLengths,
    dataUsageAvailable: false
  };
}

module.exports = { normalizeDays, comparison, periodMetrics, load };
