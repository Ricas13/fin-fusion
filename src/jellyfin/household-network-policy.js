'use strict';

const { query } = require('../db');
const { decryptString } = require('../crypto');
const modules = require('../modules/registry');
const planComponents = require('../access/plan-components');
const networkIdentity = require('../access/network-identity');
const leases = require('../access/network-leases');
const registry = require('./registry');
const householdOverrides = require('../entitlements/household-overrides');

function lane(value) { return String(value || '') === 'free' ? 'free' : 'primary'; }

async function activeSessions() {
  const result = await query(
    `SELECT aps.server_id,aps.jellyfin_session_id,aps.customer_id,aps.jellyfin_account_id,
            aps.jellyfin_user_id,aps.remote_endpoint_encrypted,aps.first_seen_at,aps.last_seen_at,
            aps.item_name,aps.client_name,aps.device_name,ja.access_lane
     FROM active_playback_sessions aps
     JOIN jellyfin_accounts ja ON ja.id=aps.jellyfin_account_id
     WHERE COALESCE(ja.account_purpose,'jellyfin')<>'stremio_internal'
     ORDER BY aps.customer_id,aps.jellyfin_account_id,aps.first_seen_at,aps.server_id,aps.jellyfin_session_id`
  );
  return result.rows;
}

function safeRemoteAddress(session) {
  try {
    return session.remote_endpoint_encrypted ? decryptString(session.remote_endpoint_encrypted) : null;
  } catch (error) {
    console.warn('Unable to decrypt Jellyfin household network endpoint:', error.message);
    return null;
  }
}

async function effectiveHousehold(customerId, accessLane = 'primary') {
  // Resolve the entitlement for the exact Jellyfin account lane. Free and paid
  // Jellyfin can coexist for one customer, so a customer-wide LIMIT 1 would let
  // one plan's household policy leak into playback owned by the other lane.
  const normalizedLane = lane(accessLane);
  const result = await query(
    `SELECT s.id AS subscription_id,s.customer_id,p.id AS plan_id,p.service_type,p.streams,
            p.jellyfin_access_model,p.jellyfin_household_network_limit,p.jellyfin_household_lease_minutes,
            CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
                 THEN 'infinity'::timestamptz
                 ELSE s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval)
            END AS access_expires_at
     FROM subscriptions s
     JOIN plans p ON p.id=s.plan_id
     JOIN customers c ON c.id=s.customer_id
     LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
     WHERE s.customer_id=$1
       AND (CASE WHEN p.is_free_tier THEN 'free' ELSE 'primary' END)=$2
       AND COALESCE(p.is_addon,FALSE)=FALSE
       AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
       AND s.superseded_by IS NULL
       AND s.starts_at<=NOW()
       AND c.access_paused_at IS NULL
       AND (
         (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
         OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
         OR (COALESCE(s.service_extension_days,0)>0
             AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
             AND s.current_period_end+(s.service_extension_days||' days')::interval>NOW())
       )
     ORDER BY access_expires_at DESC,s.created_at DESC
     LIMIT 1`,
    [customerId, normalizedLane]
  );
  const entitlement = result.rows[0] || null;
  if (!entitlement) return null;
  const override = await householdOverrides.get(customerId, 'jellyfin');
  if (override && override.network_limit != null) entitlement.jellyfin_household_network_limit = override.network_limit;
  const component = planComponents.componentForPlan(entitlement, 'jellyfin');
  if (!component || component.driver !== 'household_network') return null;
  return { entitlement, component, accessLane: normalizedLane };
}

async function claimSession(session, household, options = {}) {
  const address = options.address || safeRemoteAddress(session);
  if (!address || !networkIdentity.canonicalNetwork(address)) return { allowed: null, decision: 'unknown_network' };
  return leases.claim({
    scope: 'jellyfin',
    subjectKey: household.entitlement.subscription_id,
    customerId: session.customer_id,
    address,
    networkLimit: household.component.config.networkLimit,
    leaseMinutes: household.component.config.leaseMinutes,
    metadata: {
      kind: 'jellyfin_playback',
      serverId: session.server_id,
      accountId: session.jellyfin_account_id,
      accessLane: household.accessLane
    }
  });
}

async function freshSession(candidate, activeWindowSeconds) {
  const sessions = await registry.request(
    candidate.server_id,
    `/Sessions?activeWithinSeconds=${encodeURIComponent(activeWindowSeconds)}`
  );
  if (!Array.isArray(sessions)) throw new Error('Media-server sessions response was not an array');
  return sessions.find(session =>
    String(session?.Id || '') === String(candidate.jellyfin_session_id) &&
    String(session?.UserId || '').toLowerCase() === String(candidate.jellyfin_user_id || '').toLowerCase() &&
    Boolean(session?.NowPlayingItem)
  ) || null;
}

async function stopDeniedSession(candidate, household, cfg) {
  let fresh;
  try {
    fresh = await freshSession(candidate, cfg.activeWindowSeconds);
  } catch (error) {
    return { stopped: false, reason: 'revalidation_failed', error: error.message };
  }
  if (!fresh) return { stopped: false, reason: 'session_ended' };
  if (fresh.SupportsMediaControl !== true) return { stopped: false, reason: 'media_control_not_supported' };
  const decision = await claimSession(candidate, household, { address: fresh.RemoteEndPoint });
  if (decision.allowed !== false) return { stopped: false, reason: 'network_changed_or_violation_cleared' };
  try {
    try {
      await registry.request(candidate.server_id, `/Sessions/${encodeURIComponent(candidate.jellyfin_session_id)}/Message`, {
        method: 'POST',
        timeoutMs: 5000,
        body: {
          Header: 'Household network limit reached',
          Text: `This plan allows ${household.component.config.networkLimit} household network${household.component.config.networkLimit === 1 ? '' : 's'}. This extra playback will stop.`,
          TimeoutMs: 8000
        }
      });
    } catch (_) {}
    await registry.request(
      candidate.server_id,
      `/Sessions/${encodeURIComponent(candidate.jellyfin_session_id)}/Playing/Stop`,
      { method: 'POST' }
    );
    await query(
      `UPDATE playback_history
       SET ended_at=NOW(),ended_reason='household_network_policy',last_seen_at=NOW()
       WHERE server_id=$1 AND jellyfin_session_id=$2 AND ended_at IS NULL`,
      [candidate.server_id, candidate.jellyfin_session_id]
    );
    await query(
      `DELETE FROM active_playback_sessions WHERE server_id=$1 AND jellyfin_session_id=$2`,
      [candidate.server_id, candidate.jellyfin_session_id]
    );
    return { stopped: true, reason: 'confirmed_household_network_limit' };
  } catch (error) {
    return { stopped: false, reason: 'media_server_stop_failed', error: error.message };
  }
}

async function runHouseholdNetworkCycle(options = {}) {
  if (!modules.isEnabled('jellyfin')) return { skipped: true, reason: 'jellyfin_module_disabled' };
  const activity = require('./activity');
  const cfg = activity.config();
  const rows = await activeSessions();
  const groups = new Map();
  for (const row of rows) {
    const key = String(row.jellyfin_account_id);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }

  const failedServerIds = new Set((options.failedServerIds || []).map(String));
  const globallyReliable = options.pollsReliable !== false;
  const customers = new Set();
  const summary = { skipped: false, customers: 0, observedSessions: 0, denied: 0, stopped: 0, safetySkipped: 0, unknownNetworks: 0 };
  for (const sessions of groups.values()) {
    const first = sessions[0];
    const household = await effectiveHousehold(first.customer_id, first.access_lane);
    if (!household) continue;
    customers.add(String(first.customer_id));
    for (const session of sessions) {
      summary.observedSessions += 1;
      let decision;
      try {
        decision = await claimSession(session, household);
      } catch (error) {
        summary.safetySkipped += 1;
        console.warn(`Jellyfin household lease failed for customer ${first.customer_id} lane ${household.accessLane}:`, error.message);
        continue;
      }
      if (decision.allowed === null) {
        summary.unknownNetworks += 1;
        continue;
      }
      if (decision.allowed) continue;
      summary.denied += 1;
      if (!globallyReliable || failedServerIds.has(String(session.server_id)) || cfg.effectiveMode !== 'enforce') {
        summary.safetySkipped += 1;
        continue;
      }
      const outcome = await stopDeniedSession(session, household, cfg);
      if (outcome.stopped) summary.stopped += 1;
      else summary.safetySkipped += 1;
    }
  }
  summary.customers = customers.size;
  await leases.cleanupExpired().catch(error => console.warn('Household network lease cleanup failed:', error.message));
  return summary;
}

module.exports = { lane, activeSessions, safeRemoteAddress, effectiveHousehold, claimSession, freshSession, stopDeniedSession, runHouseholdNetworkCycle };
