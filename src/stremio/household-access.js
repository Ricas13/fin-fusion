'use strict';

const { query } = require('../db');
const modules = require('../modules/registry');
const planComponents = require('../access/plan-components');
const leases = require('../access/network-leases');
const networkIdentity = require('../access/network-identity');

async function planForEntitlement(entitlement) {
  if (!entitlement?.plan_id) throw new Error('Stremio entitlement has no plan.');
  const result = await query(
    `SELECT id,service_type,streams,jellyfin_access_model,
            jellyfin_household_network_limit,jellyfin_household_lease_minutes,
            stremio_household_lease_minutes
     FROM plans WHERE id=$1`,
    [entitlement.plan_id]
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

function familyLabel(decision) {
  if (decision?.networkFamily === 'ipv4') return 'IPv4';
  if (decision?.networkFamily === 'ipv6') return 'IPv6';
  return 'network';
}

function deniedTitle() {
  return 'Different home IP detected';
}

function deniedMessage(decision) {
  const family = familyLabel(decision);
  const homeNetwork = family === 'network' ? 'home network' : `home ${family} network`;
  const currentNetwork = family === 'network' ? 'network' : `${family} network`;
  return `This Stremio plan is already linked to the ${homeNetwork} used by this subscription. Your current ${currentNetwork} is different, so playback is blocked. Connect from the home network, wait for the lease to expire, or reset your household IP lease from your account.`;
}

function deniedStream(decision, options = {}) {
  const title = deniedTitle();
  const description = deniedMessage(decision);
  const stream = {
    name: `CAPTAiNFiN - ${title}`,
    title,
    description
  };
  if (options.externalUrl) stream.externalUrl = String(options.externalUrl);
  return stream;
}

function applyDeniedResponse(res, decision) {
  const retry = Math.max(1, Number(decision?.retryAfterSeconds || 60));
  res.setHeader('Retry-After', String(retry));
  res.setHeader('X-CAPTAiNFiN-429-Reason', 'household_network');
  return res.status(429).json({ error: deniedTitle(), message: deniedMessage(decision) });
}

async function release(entitlement, { actorUserId = null, reason = 'manual_reset' } = {}) {
  await configForEntitlement(entitlement);
  const released = await leases.releaseSubject({ scope: 'stremio', subjectKey: subjectKey(entitlement) });
  await query(
    `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
     VALUES($1,'stremio.household_lease.reset','stremio_entitlement',$2,$3::jsonb)`,
    [actorUserId, entitlement.id, JSON.stringify({ subscriptionId: entitlement.subscription_id || null, released, reason: String(reason || 'manual_reset').slice(0, 80) })]
  );
  return released;
}

module.exports = { planForEntitlement, subjectKey, configForEntitlement, claim, preview, deniedTitle, deniedMessage, deniedStream, applyDeniedResponse, release };
