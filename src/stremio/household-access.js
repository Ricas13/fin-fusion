'use strict';

const { query } = require('../db');
const modules = require('../modules/registry');
const planComponents = require('../access/plan-components');
const leases = require('../access/network-leases');
const networkIdentity = require('../access/network-identity');

async function planForEntitlement(entitlement) {
  if (!entitlement?.plan_id) throw new Error('Stremio entitlement has no plan.');
  const result = await query(
    `SELECT id,service_type,streams,jellyfin_access_model,household_network_limit,household_lease_minutes
     FROM plans WHERE id=$1`,
    [entitlement.plan_id]
  );
  if (!result.rowCount) throw new Error('Stremio plan no longer exists.');
  return result.rows[0];
}

async function claim(entitlement, req, options = {}) {
  modules.assertEnabled('stremio');
  const plan = await planForEntitlement(entitlement);
  const component = planComponents.componentForPlan(plan, 'stremio');
  if (!component || component.driver !== 'household_network') throw new Error('Stremio household access is not configured for this plan.');
  const address = networkIdentity.requestAddress(req);
  return leases.claim({
    scope: 'stremio',
    subjectKey: entitlement.subscription_id || entitlement.id,
    customerId: entitlement.customer_id,
    address,
    networkLimit: component.config.networkLimit,
    leaseMinutes: component.config.leaseMinutes,
    metadata: { kind: String(options.kind || 'playback').slice(0,80) }
  });
}

function applyDeniedResponse(res, decision) {
  const retry = Math.max(1, Number(decision?.retryAfterSeconds || 60));
  res.setHeader('Retry-After', String(retry));
  res.setHeader('X-CAPTAiNFiN-429-Reason', 'household_network');
  return res.status(429).json({ error: 'This Stremio household is currently active on another network.' });
}

module.exports = { planForEntitlement, claim, applyDeniedResponse };
