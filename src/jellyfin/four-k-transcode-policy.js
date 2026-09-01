'use strict';

const { getPool, query } = require('../db');
const registry = require('./registry');
const activity = require('./activity');

const ADVISORY_LOCK_ID = 637441015;
const POLICY_REASON = 'plan_4k_transcode_kick';

function finiteDimension(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sessionVideoDimensions(session = {}) {
  const sourceWidth = finiteDimension(session?.NowPlayingItem?.Width);
  const sourceHeight = finiteDimension(session?.NowPlayingItem?.Height);
  const transcodeWidth = finiteDimension(session?.TranscodingInfo?.Width);
  const transcodeHeight = finiteDimension(session?.TranscodingInfo?.Height);
  return { sourceWidth, sourceHeight, transcodeWidth, transcodeHeight };
}

function isVideoTranscode(session = {}) {
  const method = String(session?.PlayState?.PlayMethod || '').toLowerCase();
  return method === 'transcode' || Boolean(session?.TranscodingInfo);
}

function isFourKVideoTranscode(session = {}) {
  if (!session?.Id || !session?.NowPlayingItem || !isVideoTranscode(session)) return false;
  const d = sessionVideoDimensions(session);
  // Treat either 3840+ horizontal pixels or 2160+ vertical pixels as positive
  // 4K evidence. Source dimensions catch a 4K item being down-converted to
  // 1080p; transcode dimensions catch output that is itself still 4K.
  return [d.sourceWidth, d.transcodeWidth].some(v => v != null && v >= 3840)
    || [d.sourceHeight, d.transcodeHeight].some(v => v != null && v >= 2160);
}

function normalizeLane(value) {
  return String(value || '') === 'free' ? 'free' : 'primary';
}

async function enabledPolicies() {
  const result = await query(`
    WITH eligible AS (
      SELECT ja.server_id,ja.id AS jellyfin_account_id,ja.customer_id,ja.jellyfin_user_id,
             CASE WHEN ja.access_lane='free' THEN 'free' ELSE 'primary' END AS access_lane,
             p.id AS plan_id,p.name AS plan_name,p.kick_4k_transcodes,s.created_at,
             CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
                  THEN 'infinity'::timestamptz
                  ELSE s.current_period_end + ((COALESCE(s.service_extension_days,0)||' days')::interval)
             END AS access_expires_at,
             ROW_NUMBER() OVER (
               PARTITION BY ja.id
               ORDER BY
                 CASE WHEN p.is_free_tier THEN 1 ELSE 0 END,
                 CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
                      THEN 'infinity'::timestamptz
                      ELSE s.current_period_end + ((COALESCE(s.service_extension_days,0)||' days')::interval)
                 END DESC,
                 s.created_at DESC
             ) AS rn
      FROM jellyfin_accounts ja
      JOIN jellyfin_servers js ON js.id=ja.server_id
      JOIN customers c ON c.id=ja.customer_id
      JOIN subscriptions s ON s.customer_id=ja.customer_id
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN customer_entitlement_overrides o
             ON o.customer_id=s.customer_id AND o.subscription_id=s.id
      WHERE ja.account_purpose='jellyfin'
        AND ja.disabled=FALSE
        AND js.enabled=TRUE
        AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
        AND COALESCE(p.is_addon,FALSE)=FALSE
        AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
        AND s.superseded_by IS NULL
        AND s.starts_at<=NOW()
        AND ((ja.access_lane='free' AND p.is_free_tier=TRUE) OR (COALESCE(ja.access_lane,'primary')<>'free' AND p.is_free_tier=FALSE))
        AND c.access_paused_at IS NULL
        AND (
          (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
          OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
          OR (COALESCE(s.service_extension_days,0)>0
              AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
              AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
        )
    )
    SELECT server_id,jellyfin_account_id,customer_id,jellyfin_user_id,access_lane,plan_id,plan_name
    FROM eligible
    WHERE rn=1 AND kick_4k_transcodes=TRUE
  `);
  return result.rows;
}

function policyKey(serverId, userId) {
  return `${String(serverId)}:${String(userId || '').toLowerCase()}`;
}

function policyMap(rows) {
  return new Map((rows || []).map(row => [policyKey(row.server_id, row.jellyfin_user_id), {
    ...row,
    access_lane: normalizeLane(row.access_lane)
  }]));
}

async function recordEvent(policy, session, cfg, decision, detail = {}) {
  const dimensions = sessionVideoDimensions(session);
  await query(`
    INSERT INTO stream_policy_events(
      customer_id,server_id,jellyfin_account_id,jellyfin_session_id,
      mode,decision,stream_count,stream_limit,reason,detail
    ) VALUES($1,$2,$3,$4,$5,$6,NULL,NULL,$7,$8::jsonb)
  `, [
    policy.customer_id,
    policy.server_id,
    policy.jellyfin_account_id,
    String(session?.Id || ''),
    cfg.effectiveMode,
    decision,
    POLICY_REASON,
    JSON.stringify({
      accessLane: policy.access_lane,
      planId: policy.plan_id,
      planName: policy.plan_name,
      itemId: session?.NowPlayingItem?.Id || null,
      itemName: session?.NowPlayingItem?.Name || null,
      ...dimensions,
      ...detail
    })
  ]);
}

async function recentlyRecorded(policy, session, decision) {
  const result = await query(`
    SELECT 1 FROM stream_policy_events
    WHERE server_id=$1 AND jellyfin_session_id=$2 AND reason=$3 AND decision=$4
      AND created_at>NOW()-INTERVAL '90 seconds'
    LIMIT 1
  `, [policy.server_id, String(session.Id), POLICY_REASON, decision]);
  return Boolean(result.rowCount);
}

async function freshSession(policy, candidate, cfg) {
  let sessions;
  try {
    sessions = await registry.request(policy.server_id, `/Sessions?activeWithinSeconds=${encodeURIComponent(cfg.activeWindowSeconds)}`);
  } catch (error) {
    return { reliable: false, error: error.message, session: null };
  }
  if (!Array.isArray(sessions)) return { reliable: false, error: 'Unexpected sessions response', session: null };
  const session = sessions.find(row =>
    String(row?.Id || '') === String(candidate?.Id || '')
    && String(row?.UserId || '').toLowerCase() === String(policy.jellyfin_user_id || '').toLowerCase()
    && String(row?.NowPlayingItem?.Id || '') === String(candidate?.NowPlayingItem?.Id || '')
  ) || null;
  return { reliable: true, session };
}

async function stopConfirmedFourKTranscode(policy, candidate, cfg) {
  const fresh = await freshSession(policy, candidate, cfg);
  if (!fresh.reliable) {
    await recordEvent(policy, candidate, cfg, 'skipped_safety', { enforcementReason: 'revalidation_failed', error: fresh.error });
    return false;
  }
  if (!fresh.session || !isFourKVideoTranscode(fresh.session)) {
    await recordEvent(policy, candidate, cfg, 'skipped_safety', { enforcementReason: 'candidate_changed_before_action' });
    return false;
  }

  try {
    await registry.request(policy.server_id, `/Sessions/${encodeURIComponent(candidate.Id)}/Message`, {
      method: 'POST',
      timeoutMs: 5000,
      body: {
        Header: '4K transcoding is not available',
        Text: 'This plan does not allow 4K video transcoding. This playback will stop. Try Direct Play or a compatible client instead.',
        TimeoutMs: 8000
      }
    });
  } catch (_) {
    // Message delivery is best-effort. A failed popup must not turn an
    // otherwise confirmed policy action into an inconsistent state.
  }

  try {
    await registry.request(policy.server_id, `/Sessions/${encodeURIComponent(candidate.Id)}/Playing/Stop`, { method: 'POST' });
  } catch (error) {
    await recordEvent(policy, candidate, cfg, 'stop_failed', { enforcementReason: 'jellyfin_stop_failed', error: error.message });
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, 750));
  const verified = await freshSession(policy, candidate, cfg);
  if (!verified.reliable) {
    await recordEvent(policy, candidate, cfg, 'stop_failed', { enforcementReason: 'post_stop_revalidation_failed', error: verified.error });
    return false;
  }
  if (verified.session && isFourKVideoTranscode(verified.session)) {
    await recordEvent(policy, candidate, cfg, 'stop_failed', { enforcementReason: 'jellyfin_stop_did_not_end_session' });
    return false;
  }

  await recordEvent(policy, candidate, cfg, 'stopped', { enforcementReason: 'confirmed_4k_video_transcode' });
  return true;
}

async function runFourKTranscodeCycle() {
  const pool = getPool();
  const lockClient = await pool.connect();
  let locked = false;
  try {
    const lock = await lockClient.query('SELECT pg_try_advisory_lock($1) AS locked', [ADVISORY_LOCK_ID]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { skipped: true, reason: 'another_4k_monitor_is_running' };

    const cfg = activity.config();
    const policies = await enabledPolicies();
    if (!policies.length) return { skipped: false, inspectedServers: 0, violations: 0, stopped: 0, failedServers: 0, mode: cfg.effectiveMode };
    const byIdentity = policyMap(policies);
    const serverIds = [...new Set(policies.map(row => String(row.server_id)))];
    const summary = { skipped: false, inspectedServers: 0, violations: 0, stopped: 0, failedServers: 0, mode: cfg.effectiveMode };

    for (const serverId of serverIds) {
      let sessions;
      try {
        sessions = await registry.request(serverId, `/Sessions?activeWithinSeconds=${encodeURIComponent(cfg.activeWindowSeconds)}`);
        if (!Array.isArray(sessions)) throw new Error('Unexpected sessions response');
        summary.inspectedServers += 1;
      } catch (error) {
        summary.failedServers += 1;
        console.warn(`4K transcode policy skipped server ${serverId}: ${error.message}`);
        continue;
      }

      for (const session of sessions) {
        const policy = byIdentity.get(policyKey(serverId, session?.UserId));
        if (!policy || !isFourKVideoTranscode(session)) continue;
        summary.violations += 1;

        if (cfg.effectiveMode !== 'enforce') {
          if (!(await recentlyRecorded(policy, session, 'would_stop'))) {
            await recordEvent(policy, session, cfg, 'would_stop', {
              enforcementReason: cfg.requestedMode === 'enforce' && !cfg.acknowledged ? 'enforcement_ack_missing' : 'observe_only'
            });
          }
          continue;
        }

        if (await stopConfirmedFourKTranscode(policy, session, cfg)) summary.stopped += 1;
      }
    }
    return summary;
  } finally {
    if (locked) {
      try { await lockClient.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_ID]); } catch (_) {}
    }
    lockClient.release();
  }
}

module.exports = {
  POLICY_REASON,
  sessionVideoDimensions,
  isVideoTranscode,
  isFourKVideoTranscode,
  policyMap,
  runFourKTranscodeCycle
};