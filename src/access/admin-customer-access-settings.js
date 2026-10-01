'use strict';

const { query } = require('../db');
const customerAccessState = require('./customer-access-state');
const provisioning = require('../jellyfin/resilient-provisioning');
const policy = require('../jellyfin/policy');
const householdOverrides = require('../entitlements/household-overrides');
const requestPolicy = require('../integrations/request-plan-policy');
const requestOverrides = require('../integrations/request-permission-overrides');
const requestUserSync = require('../integrations/request-user-sync');
const stremioEntitlements = require('../stremio/entitlements');
const stremioHouseholdAccess = require('../stremio/household-access');

function lane(value) {
  return String(value || 'primary') === 'free' ? 'free' : 'primary';
}

async function audit(actorUserId, action, customerId, metadata = {}) {
  await query(
    `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
     VALUES($1,$2,'customer',$3,$4::jsonb)`,
    [actorUserId, action, customerId, JSON.stringify(metadata)]
  );
}

async function accessSnapshot(customerId) {
  return customerAccessState.snapshot(customerId);
}

async function resetStremioHousehold(customerId, { actorUserId = null } = {}) {
  const entitlement = await stremioEntitlements.current(customerId);
  if (!entitlement || !['active','pending','suspended'].includes(String(entitlement.status || ''))) {
    throw new Error('This customer has no Stremio household entitlement to reset.');
  }
  const released = await stremioHouseholdAccess.release(entitlement, {
    actorUserId,
    reason: 'admin_reset'
  });
  return { released };
}

async function savePolicyOverrides(customerId, body = {}, { actorUserId = null } = {}) {
  const changed = [];
  for (const field of policy.TECHNICAL_FIELDS) {
    const raw = body[field];
    if (raw === undefined) continue;
    const value = String(raw).trim();
    if (value === '') {
      await provisioning.resetPolicyOverrideField(customerId, field, actorUserId);
    } else if (field === 'streams') {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isInteger(parsed) || parsed < 1 || parsed > 50) {
        throw new Error('Concurrent streams must be between 1 and 50.');
      }
      await provisioning.setPolicyOverrideField(customerId, field, parsed, actorUserId);
    } else {
      if (value !== 'true' && value !== 'false') throw new Error(`Invalid ${field} override.`);
      await provisioning.setPolicyOverrideField(customerId, field, value === 'true', actorUserId);
    }
    changed.push(field);
  }
  await audit(actorUserId, 'admin.customer.policy_override', customerId, { fields: changed });
  await provisioning.reconcileCustomer(customerId);
  return { fields: changed };
}

async function resetPolicyOverrides(customerId, { actorUserId = null } = {}) {
  await provisioning.resetAllPolicyOverrides(customerId, actorUserId);
  await audit(actorUserId, 'admin.customer.policy_override_reset_all', customerId);
  await provisioning.reconcileCustomer(customerId);
}

async function saveHouseholdOverrides(customerId, body = {}, { actorUserId = null } = {}) {
  const changed = [];
  for (const service of householdOverrides.SERVICES) {
    const raw = body[service];
    if (raw === undefined) continue;
    const value = String(raw).trim();
    if (value === '') await householdOverrides.reset(customerId, service);
    else await householdOverrides.set(customerId, service, value, actorUserId);
    changed.push(service);
  }
  await audit(actorUserId, 'admin.customer.household_override', customerId, { services: changed });
  await provisioning.reconcileCustomer(customerId);
  return { services: changed };
}

async function resetHouseholdOverrides(customerId, { actorUserId = null } = {}) {
  await Promise.all(householdOverrides.SERVICES.map(service => householdOverrides.reset(customerId, service)));
  await audit(actorUserId, 'admin.customer.household_override_reset_all', customerId);
  await provisioning.reconcileCustomer(customerId);
}

async function entitlementForLane(customerId, accessLane) {
  const snapshot = await accessSnapshot(customerId);
  const state = snapshot[lane(accessLane)];
  return state?.entitlement || null;
}

async function saveLibraryOverrides(customerId, accessLane, body = {}, { actorUserId = null } = {}) {
  const normalizedLane = lane(accessLane);
  const plan = await entitlementForLane(customerId, normalizedLane);
  if (!plan) {
    throw new Error(`This customer has no active ${normalizedLane === 'free' ? 'Free' : 'Premium'} plan to override libraries against.`);
  }
  const catalog = await provisioning.libraryCatalogForServerClass(plan.server_class);
  const known = new Set(catalog.names.map(name => policy.nameKey(name)));
  const names = Array.isArray(body.libraryName)
    ? body.libraryName
    : (body.libraryName !== undefined ? [body.libraryName] : []);
  const changed = [];
  for (let index = 0; index < names.length; index += 1) {
    const name = String(names[index] || '').trim();
    const value = String(body[`libraryValue_${normalizedLane}_${index}`] || '').trim();
    if (!name || !known.has(policy.nameKey(name))) continue;
    if (value === '') {
      await provisioning.resetLibraryOverride(customerId, name, normalizedLane);
    } else if (value === 'true' || value === 'false') {
      await provisioning.setLibraryOverride(customerId, name, value === 'true', actorUserId, normalizedLane);
    } else {
      continue;
    }
    changed.push(name);
  }
  await audit(actorUserId, 'admin.customer.library_override', customerId, {
    libraries: changed,
    accessLane: normalizedLane
  });
  await provisioning.reconcileCustomer(customerId);
  return { accessLane: normalizedLane, libraries: changed };
}

async function resetLibraryOverrides(customerId, accessLane, { actorUserId = null } = {}) {
  const normalizedLane = lane(accessLane);
  await provisioning.resetAllLibraryOverrides(customerId, normalizedLane);
  await audit(actorUserId, 'admin.customer.library_override_reset_all', customerId, {
    accessLane: normalizedLane
  });
  await provisioning.reconcileCustomer(customerId);
  return { accessLane: normalizedLane };
}

async function requestEntitlement(customerId) {
  const snapshot = await accessSnapshot(customerId);
  return snapshot.primary?.entitlement
    || snapshot.free?.entitlement
    || snapshot.stremio?.entitlement
    || null;
}

async function saveRequestPermissionOverrides(customerId, body = {}, { actorUserId = null } = {}) {
  const plan = await requestEntitlement(customerId);
  const planMask = plan?.request_permissions ?? null;
  const effective = await requestOverrides.effectivePermissions(customerId, planMask);
  let mask = 0n;
  let touched = false;
  for (const item of requestPolicy.CUSTOMER_PERMISSION_DEFS) {
    const raw = body[`permission_${item.key}`];
    let value;
    if (raw === 'true') {
      value = true;
      touched = true;
    } else if (raw === 'false') {
      value = false;
      touched = true;
    } else {
      const row = effective.rows.find(candidate => candidate.key === item.key);
      value = Boolean(row?.effective);
    }
    if (value) mask |= BigInt(item.bit);
  }

  if (touched) await requestOverrides.setOverrideMask(customerId, Number(mask), actorUserId);
  else await requestOverrides.resetOverride(customerId, actorUserId);

  await audit(actorUserId, 'admin.customer.request_permission_override', customerId, {
    mask: touched ? Number(mask) : null
  });

  let syncWarning = '';
  try {
    await requestUserSync.syncOneCustomer(customerId);
  } catch (error) {
    syncWarning = String(error.message || '').slice(0, 150);
  }
  return { mask: touched ? Number(mask) : null, syncWarning };
}

async function resetRequestPermissionOverrides(customerId, { actorUserId = null } = {}) {
  await requestOverrides.resetOverride(customerId, actorUserId);
  await audit(actorUserId, 'admin.customer.request_permission_override_reset_all', customerId);

  let syncWarning = '';
  try {
    await requestUserSync.syncOneCustomer(customerId);
  } catch (error) {
    syncWarning = String(error.message || '').slice(0, 150);
  }
  return { syncWarning };
}

module.exports = {
  lane,
  resetStremioHousehold,
  savePolicyOverrides,
  resetPolicyOverrides,
  saveHouseholdOverrides,
  resetHouseholdOverrides,
  entitlementForLane,
  saveLibraryOverrides,
  resetLibraryOverrides,
  requestEntitlement,
  saveRequestPermissionOverrides,
  resetRequestPermissionOverrides
};
