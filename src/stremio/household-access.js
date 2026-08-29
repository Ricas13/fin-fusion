'use strict';

const { query } = require('../db');
const modules = require('../modules/registry');
const planComponents = require('../access/plan-components');
const leases = require('../access/network-leases');
const networkIdentity = require('../access/network-identity');
const householdOverrides = require('../entitlements/household-overrides');

async function planForEntitlement(entitlement) {
  if (!entitlement?.plan_id) throw new Error('Stremio entitlement has no plan.');
  const result = await query(
    `SELECT p.id,p.service_type,p.streams,p.jellyfin_access_model,
            p.jellyfin_household_network_limit,p.jellyfin_household_lease_minutes,
            COALESCE(s.stremio_household_network_limit_snapshot,p.stremio_household_network_limit) stremio_household_network_limit,
            p.stremio_household_lease_minutes,
            COALESCE(s.stremio_ip_replacement_policy_snapshot,p.stremio_ip_replacement_policy) stremio_ip_replacement_policy,
            COALESCE(s.stremio_ip_replacement_cooldown_minutes_snapshot,p.stremio_ip_replacement_cooldown_minutes) stremio_ip_replacement_cooldown_minutes
     FROM plans p
     LEFT JOIN subscriptions s ON s.id=$2
     WHERE p.id=$1`,
    [entitlement.plan_id, entitlement.subscription_id || null]
  );
  if (!result.rowCount) throw new Error('Stremio plan no longer exists.');
  return result.rows[0];
}

function subjectKey(entitlement) {
  return entitlement?.subscription_id || entitlement?.id;
}

async function configForEntitlement(entitlement) {
  modules.assertEnabled('stremio');
  const plan = await planForEntitlement(entitlement);
  const override = await householdOverrides.get(entitlement.customer_id, 'stremio');
  if (override && override.network_limit != null) plan.stremio_household_network_limit = override.network_limit;
  const component = planComponents.componentForPlan(plan, 'stremio');
  if (!component || component.driver !== 'household_network') throw new Error('Stremio household access is not configured for this plan.');
  return { plan, component };
}

function leaseOptions(entitlement, component, address, options = {}) {
  return {
    scope: 'stremio',
    subjectKey: subjectKey(entitlement),
    customerId: entitlement.customer_id,
    address,
    networkLimit: component.config.networkLimit,
    leaseMinutes: component.config.leaseMinutes,
    metadata: { kind: String(options.kind || 'playback').slice(0, 80) }
  };
}

async function claim(entitlement, req, options = {}) {
  const { component } = await configForEntitlement(entitlement);
  const address = networkIdentity.requestAddress(req);
  return leases.claim(leaseOptions(entitlement, component, address, options));
}

async function preview(entitlement, req, options = {}) {
  const address = networkIdentity.requestAddress(req);
  if (!networkIdentity.networkDescriptor(address)) return { allowed: true, decision: 'unknown_network' };
  const { component } = await configForEntitlement(entitlement);
  return leases.preview(leaseOptions(entitlement, component, address, options));
}

function deniedTitle() {
  return 'Outside household connection';
}

function deniedMessage(_decision) {
  return 'This Stremio plan is already linked to another household internet connection. The connection you are using now is different, so playback is blocked. Connect from the registered household connection, wait until it can be replaced automatically, or change your household connection from your account when eligible.';
}

function blockedMediaIsWebReady(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && /\.mp4$/i.test(url.pathname);
  } catch (_error) {
    return false;
  }
}

function deniedStream(decision, options = {}) {
  const title = deniedTitle();
  const description = deniedMessage(decision);
  const url = options.url ? String(options.url) : '';
  const stream = {
    name: `CAPTAiNFiN • ${title}`,
    title,
    description,
    behaviorHints: {
      // The local explanation is a real HTTPS MP4 in production, so it must
      // remain web-ready. Marking an HTTPS MP4 as notWebReady makes Stremio Web
      // hide the only denial result and fall back to "no addons provided streams".
      notWebReady: url ? !blockedMediaIsWebReady(url) : true,
      bingeGroup: 'captainfin-household-ip-block',
      filename: 'CAPTAiNFiN household connection blocked.mp4'
    }
  };
  if (Number(options.videoSize) > 0) stream.behaviorHints.videoSize = Number(options.videoSize);
  if (url) stream.url = url;
  if (options.externalUrl) {
    const externalUrl = String(options.externalUrl);
    stream.externalUrl = externalUrl;
    if (!stream.url) stream.url = externalUrl;
  }
  return stream;
}

function applyDeniedResponse(res, decision) {
  const retry = Math.max(1, Number(decision?.retryAfterSeconds || 60));
  res.setHeader('Retry-After', String(retry));
  res.setHeader('X-CAPTAiNFiN-429-Reason', 'household_network');
  return res.status(429).json({ error: deniedTitle(), message: deniedMessage(decision) });
}

async function replacementState(entitlement) {
  const { component } = await configForEntitlement(entitlement);
  const policy = component.config.replacementPolicy || 'auto_inactive';
  const cooldownMinutes = Number(component.config.cooldownMinutes || 1440);
  if (policy !== 'customer_cooldown') return { allowed: true, policy, cooldownMinutes, retryAfterSeconds: 0, nextAllowedAt: null };
  const active = await leases.activeForSubject({ scope: 'stremio', subjectKey: subjectKey(entitlement) });
  if (!active.length) return { allowed: true, policy, cooldownMinutes, retryAfterSeconds: 0, nextAllowedAt: null };
  const newestClaimAt = active.reduce((latest, row) => {
    const value = new Date(row.first_seen_at).getTime();
    return Number.isFinite(value) ? Math.max(latest, value) : latest;
  }, 0);
  if (!newestClaimAt) return { allowed: true, policy, cooldownMinutes, retryAfterSeconds: 0, nextAllowedAt: null };
  const nextAllowedAt = new Date(newestClaimAt + cooldownMinutes * 60_000);
  const retryAfterSeconds = Math.max(0, Math.ceil((nextAllowedAt.getTime() - Date.now()) / 1000));
  return { allowed: retryAfterSeconds === 0, policy, cooldownMinutes, retryAfterSeconds, nextAllowedAt };
}

function cooldownMessage(state) {
  const minutes = Math.max(1, Math.ceil(Number(state?.retryAfterSeconds || 60) / 60));
  if (minutes >= 60) {
    const hours = Math.ceil(minutes / 60);
    return `This household connection can be changed in about ${hours} hour${hours === 1 ? '' : 's'}.`;
  }
  return `This household connection can be changed in about ${minutes} minute${minutes === 1 ? '' : 's'}.`;
}

async function release(entitlement, { actorUserId = null, reason = 'manual_reset', customerInitiated = false } = {}) {
  const state = await replacementState(entitlement);
  if (customerInitiated && !state.allowed) throw new Error(cooldownMessage(state));
  const released = await leases.releaseSubject({ scope: 'stremio', subjectKey: subjectKey(entitlement) });
  await query(
    `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
     VALUES($1,'stremio.household_lease.reset','stremio_entitlement',$2,$3::jsonb)`,
    [actorUserId, entitlement.id, JSON.stringify({ subscriptionId: entitlement.subscription_id || null, released, reason: String(reason || 'manual_reset').slice(0, 80), customerInitiated: Boolean(customerInitiated), replacementPolicy: state.policy })]
  );
  return released;
}

module.exports = { planForEntitlement, subjectKey, configForEntitlement, claim, preview, deniedTitle, deniedMessage, blockedMediaIsWebReady, deniedStream, applyDeniedResponse, replacementState, cooldownMessage, release };
