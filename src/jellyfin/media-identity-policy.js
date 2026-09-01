'use strict';

const net = require('net');
const { getPool, query } = require('../db');
const registry = require('./registry');
const activity = require('./activity');
const mediaPlanPolicy = require('./media-plan-policy-settings');
const deviceAccessPolicy = require('./device-access-policy');

const IDENTITY_ADVISORY_LOCK_ID = 637441016;
const IP_REASON = 'confirmed_active_ip_limit';
// Retained for historical log compatibility. Device limits are now persistent
// native Jellyfin/Emby allowlists rather than simultaneous-device counters.
const DEVICE_REASON = 'confirmed_active_device_limit';
const COMBINED_REASON = 'confirmed_media_identity_limits';

function lane(value) { return String(value || '') === 'free' ? 'free' : 'primary'; }
function countable(row, cfg) { return cfg.countPaused || !row.isPaused; }

function canonicalRemoteIp(value) {
  let raw = String(value || '').trim();
  if (!raw) return null;
  const bracket = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) raw = bracket[1];
  if (net.isIP(raw)) {
    const mapped = raw.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
    return raw.toLowerCase();
  }
  const ipv4Port = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (ipv4Port && net.isIP(ipv4Port[1]) === 4) return ipv4Port[1];
  return null;
}

function identityOverflow(rows, field, limit, cfg) {
  const parsedLimit = Number(limit);
  if (!Number.isInteger(parsedLimit) || parsedLimit < 1) return { count: 0, overflow: [] };
  const eligible = rows
    .filter(row => countable(row, cfg) && row[field])
    .sort((a, b) => {
      const time = new Date(a.firstSeenAt || a.first_seen_at || 0) - new Date(b.firstSeenAt || b.first_seen_at || 0);
      if (time) return time;
      return String(a.sessionId || a.jellyfin_session_id || '').localeCompare(String(b.sessionId || b.jellyfin_session_id || ''));
    });
  const orderedIdentities = [];
  const seen = new Set();
  for (const row of eligible) {
    const identity = String(row[field]);
    if (seen.has(identity)) continue;
    seen.add(identity);
    orderedIdentities.push(identity);
  }
  const allowed = new Set(orderedIdentities.slice(0, parsedLimit));
  return {
    count: orderedIdentities.length,
    overflow: eligible.filter(row => !allowed.has(String(row[field])))
  };
}

async function laneEntitlements(customerIds) {
  const ids = [...new Set((customerIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Map();
  const result = await query(`
    SELECT s.customer_id,s.id AS subscription_id,s.plan_id,
           CASE WHEN p.is_free_tier THEN 'free' ELSE 'primary' END AS access_lane,
           s.created_at,
           CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
                THEN 'infinity'::timestamptz
                ELSE s.current_period_end + ((COALESCE(s.service_extension_days,0)||' days')::interval)
           END AS access_expires_at
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    JOIN customers c ON c.id=s.customer_id
    LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
    WHERE s.customer_id=ANY($1::uuid[])
      AND c.access_paused_at IS NULL
      AND COALESCE(p.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND s.superseded_by IS NULL
      AND s.starts_at<=NOW()
      AND (
        (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
        OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
        OR (COALESCE(s.service_extension_days,0)>0
            AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
            AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
      )
    ORDER BY s.customer_id,CASE WHEN p.is_free_tier THEN 1 ELSE 0 END,access_expires_at DESC,s.created_at DESC
  `, [ids]);
  const map = new Map();
  for (const row of result.rows) {
    const key = `${row.customer_id}:${lane(row.access_lane)}`;
    if (!map.has(key)) map.set(key, row);
  }
  return map;
}

async function observedGroups() {
  const result = await query(`
    SELECT aps.server_id,aps.jellyfin_session_id,aps.playback_key,aps.customer_id,
           aps.jellyfin_account_id,aps.jellyfin_user_id,aps.is_paused,aps.first_seen_at,
           ja.access_lane,ja.disabled
    FROM active_playback_sessions aps
    JOIN jellyfin_accounts ja ON ja.id=aps.jellyfin_account_id
    WHERE ja.account_purpose='jellyfin'
  `);
  const entitlements = await laneEntitlements(result.rows.map(row => row.customer_id));
  const planIds = [];
  for (const row of result.rows) {
    const entitlement = entitlements.get(`${row.customer_id}:${lane(row.access_lane)}`);
    if (entitlement?.plan_id) planIds.push(String(entitlement.plan_id));
  }
  const policies = await mediaPlanPolicy.getMany(planIds);
  const groups = new Map();
  for (const row of result.rows) {
    if (row.disabled) continue;
    const entitlement = entitlements.get(`${row.customer_id}:${lane(row.access_lane)}`);
    if (!entitlement) continue;
    const policy = policies.get(String(entitlement.plan_id)) || mediaPlanPolicy.DEFAULTS;
    // Device limits are intentionally absent here: they are persistent native
    // per-user device allowlists, not counts of simultaneously playing devices.
    if (!policy.ipLimit) continue;
    const item = {
      ...row,
      sessionId: String(row.jellyfin_session_id),
      customerId: String(row.customer_id),
      accountId: String(row.jellyfin_account_id),
      jellyfinUserId: String(row.jellyfin_user_id),
      serverId: String(row.server_id),
      firstSeenAt: row.first_seen_at,
      isPaused: Boolean(row.is_paused),
      accessLane: lane(row.access_lane),
      planId: String(entitlement.plan_id),
      ipLimit: policy.ipLimit,
      deviceLimit: null
    };
    if (!groups.has(item.accountId)) groups.set(item.accountId, []);
    groups.get(item.accountId).push(item);
  }
  return groups;
}

async function liveGroup(group, cfg) {
  const first = group[0];
  const persisted = new Map(group.map(row => [String(row.sessionId), row.firstSeenAt]));
  let sessions;
  try {
    sessions = await registry.request(first.serverId, `/Sessions?activeWithinSeconds=${encodeURIComponent(cfg.activeWindowSeconds)}`);
  } catch (error) {
    return { reliable: false, error: error.message, rows: [] };
  }
  if (!Array.isArray(sessions)) return { reliable: false, error: 'Unexpected sessions response', rows: [] };
  const userId = String(first.jellyfinUserId).toLowerCase();
  return {
    reliable: true,
    rows: sessions
      .filter(session => session?.Id && session?.NowPlayingItem && String(session.UserId || '').toLowerCase() === userId)
      .map(session => ({
        sessionId: String(session.Id),
        isPaused: Boolean(session?.PlayState?.IsPaused),
        firstSeenAt: persisted.get(String(session.Id)) || new Date(),
        deviceIdentity: null,
        ipIdentity: canonicalRemoteIp(session.RemoteEndPoint)
      }))
  };
}

function violationsFor(rows, group, cfg) {
  const first = group[0];
  const ip = identityOverflow(rows, 'ipIdentity', first.ipLimit, cfg);
  const device = { count: 0, overflow: [] };
  const map = new Map();
  for (const row of ip.overflow) map.set(row.sessionId, { sessionId: row.sessionId, ip: true, device: false, ipCount: ip.count, deviceCount: 0 });
  return { ip, device, map };
}

async function policyEvent(row, cfg, decision, violation, reason, detail = {}) {
  const count = violation.ipCount;
  const limit = row.ipLimit;
  await query(`
    INSERT INTO stream_policy_events(customer_id,server_id,jellyfin_account_id,jellyfin_session_id,mode,decision,stream_count,stream_limit,reason,detail)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
  `, [row.customerId,row.serverId,row.accountId,row.sessionId,cfg.effectiveMode,decision,count || null,limit || null,reason,
    JSON.stringify({ planId: row.planId, accessLane: row.accessLane, ipLimit: row.ipLimit, ...detail })]);
}

function warningText(row) {
  return `This plan allows up to ${row.ipLimit} active IP address${row.ipLimit === 1 ? '' : 'es'} at once. This playback is from an excess IP and will stop now.`;
}

async function stopCandidate(row, group, cfg, originalViolation) {
  const fresh = await liveGroup(group, cfg);
  if (!fresh.reliable) {
    await policyEvent(row, cfg, 'skipped_safety', originalViolation, 'media_identity_revalidation_failed', { error: fresh.error });
    return false;
  }
  const current = violationsFor(fresh.rows, group, cfg);
  const violation = current.map.get(row.sessionId);
  if (!violation) {
    await policyEvent(row, cfg, 'skipped_safety', originalViolation, 'media_identity_violation_cleared_before_action');
    return false;
  }

  let notice = { attempted: true, accepted: false };
  try {
    await registry.request(row.serverId, `/Sessions/${encodeURIComponent(row.sessionId)}/Message`, {
      method: 'POST', timeoutMs: 5000,
      body: { Header: 'Plan IP limit reached', Text: warningText(row), TimeoutMs: 8000 }
    });
    notice = { attempted: true, accepted: true };
  } catch (error) {
    notice = { attempted: true, accepted: false, error: error.message };
  }

  try {
    await registry.request(row.serverId, `/Sessions/${encodeURIComponent(row.sessionId)}/Playing/Stop`, { method: 'POST', timeoutMs: 5000 });
  } catch (error) {
    await policyEvent(row, cfg, 'stop_failed', violation, 'media_identity_stop_failed', { error: error.message, notice });
    return false;
  }

  await new Promise(resolve => setTimeout(resolve, 750));
  const verified = await liveGroup(group, cfg);
  if (!verified.reliable) {
    await policyEvent(row, cfg, 'stop_failed', violation, 'media_identity_post_stop_revalidation_failed', { error: verified.error, notice });
    return false;
  }
  if (verified.rows.some(session => session.sessionId === row.sessionId)) {
    await policyEvent(row, cfg, 'stop_failed', violation, 'media_identity_stop_did_not_end_session', { notice });
    return false;
  }

  await query(`UPDATE playback_history SET ended_at=NOW(),ended_reason='policy_stop',last_seen_at=NOW() WHERE server_id=$1 AND playback_key=$2`, [row.serverId,row.playback_key]);
  await query(`DELETE FROM active_playback_sessions WHERE server_id=$1 AND jellyfin_session_id=$2`, [row.serverId,row.sessionId]);
  await policyEvent(row, cfg, 'stopped', violation, IP_REASON, { notice });
  return true;
}

async function evaluate(groups, failedServerIds, cfg) {
  const summary = { identities: groups.size, violations: 0, stopped: 0, skipped: 0 };
  for (const group of groups.values()) {
    const live = await liveGroup(group, cfg);
    if (!live.reliable) {
      summary.skipped += 1;
      continue;
    }
    const evaluated = violationsFor(live.rows, group, cfg);
    if (!evaluated.map.size) continue;
    summary.violations += evaluated.map.size;
    for (const row of group) {
      const violation = evaluated.map.get(row.sessionId);
      if (!violation) continue;
      const ageSeconds = (Date.now() - new Date(row.firstSeenAt || 0).getTime()) / 1000;
      if (ageSeconds < cfg.graceSeconds) {
        await policyEvent(row, cfg, 'pending', violation, 'media_identity_grace_period', { ageSeconds: Math.floor(ageSeconds) });
        continue;
      }
      if (failedServerIds.has(row.serverId)) {
        summary.skipped += 1;
        await policyEvent(row, cfg, 'skipped_safety', violation, 'media_identity_incomplete_server_snapshot');
        continue;
      }
      if (cfg.effectiveMode !== 'enforce') {
        await policyEvent(row, cfg, 'would_stop', violation, cfg.requestedMode === 'enforce' && !cfg.acknowledged ? 'enforcement_ack_missing' : 'observe_only', { mediaIdentity: true });
        continue;
      }
      if (await stopCandidate(row, group, cfg, violation)) summary.stopped += 1;
      else summary.skipped += 1;
    }
  }
  return summary;
}

async function runMediaIdentityPolicyCycle({ failedServerIds = [] } = {}) {
  const pool = getPool();
  const client = await pool.connect();
  let locked = false;
  try {
    const lock = await client.query('SELECT pg_try_advisory_lock($1) AS locked', [IDENTITY_ADVISORY_LOCK_ID]);
    locked = Boolean(lock.rows[0]?.locked);
    if (!locked) return { skipped: true, reason: 'another_media_identity_monitor_is_running' };
    const cfg = activity.config();
    const groups = await observedGroups();
    const failed = new Set((failedServerIds || []).map(String));
    const ipSummary = await evaluate(groups, failed, cfg);
    const deviceSummary = await deviceAccessPolicy.runDeviceAccessPolicyCycle({ failedServerIds });
    return {
      skipped: false,
      mode: cfg.effectiveMode,
      ...ipSummary,
      deviceAccounts: deviceSummary.accounts,
      deviceRegistered: deviceSummary.registered,
      deviceEnforced: deviceSummary.enforced,
      deviceReleased: deviceSummary.released,
      deviceStopped: deviceSummary.stopped,
      deviceFailed: deviceSummary.failed,
      deviceSafetySkipped: deviceSummary.safetySkipped
    };
  } finally {
    if (locked) {
      try { await client.query('SELECT pg_advisory_unlock($1)', [IDENTITY_ADVISORY_LOCK_ID]); } catch (_) {}
    }
    client.release();
  }
}

module.exports = {
  IDENTITY_ADVISORY_LOCK_ID,
  IP_REASON,
  DEVICE_REASON,
  COMBINED_REASON,
  canonicalRemoteIp,
  identityOverflow,
  warningText,
  runMediaIdentityPolicyCycle,
  evaluate
};
