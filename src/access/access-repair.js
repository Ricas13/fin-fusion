'use strict';

const customerAccessState = require('./customer-access-state');
const provisioning = require('../jellyfin/resilient-provisioning');

function trialEntitlement(entitlement) {
  return String(entitlement?.contract_billing_interval || entitlement?.billing_interval || '').toLowerCase() === 'trial';
}

async function repairFreeEntitlement(customerId, subscriptionId, { reason = null } = {}) {
  let access = await customerAccessState.freeJellyfin(customerId, { includeBlocked: true });
  if (!access.entitlement || String(access.entitlement.subscription_id || '') !== String(subscriptionId || '')) {
    return { status: 'skipped', reason: 'subscription_changed' };
  }
  if (access.state === customerAccessState.ACCESS_STATES.ACTIVE_BLOCKED) {
    return { status: 'skipped', reason: 'blocked' };
  }
  if (access.state === customerAccessState.ACCESS_STATES.ACTIVE_READY) {
    return { status: 'ready', account: access.account };
  }

  let reconcileError = null;
  try {
    await provisioning.reconcileCustomer(customerId);
  } catch (error) {
    reconcileError = error;
  }

  access = await customerAccessState.freeJellyfin(customerId, { includeBlocked: true });
  if (access.entitlement
      && String(access.entitlement.subscription_id || '') === String(subscriptionId || '')
      && access.state === customerAccessState.ACCESS_STATES.ACTIVE_READY) {
    return { status: 'repaired', account: access.account };
  }

  // Re-check exact ownership before rollback. A concurrent replacement must
  // never be deleted while repairing an older Free episode.
  if (!access.entitlement || String(access.entitlement.subscription_id || '') !== String(subscriptionId || '')) {
    return { status: 'skipped', reason: 'subscription_changed_after_reconcile' };
  }
  if (access.state === customerAccessState.ACCESS_STATES.ACTIVE_BLOCKED) {
    return { status: 'skipped', reason: 'blocked_after_reconcile' };
  }

  const lifecycle = require('../payments/lifecycle');
  await lifecycle.rollbackUnprovisionedFreeClaim(customerId, subscriptionId, {
    reason: reconcileError?.message || reason || 'Free entitlement had no enabled Free Server account'
  });
  return { status: 'removed', reconcileError };
}

async function repairUnpaidTrial(customerId, { reason = null } = {}) {
  const access = await customerAccessState.primaryJellyfin(customerId, { includeBlocked: true });
  const entitlement = access.entitlement;
  if (!entitlement
      || access.state !== customerAccessState.ACCESS_STATES.INCONSISTENT_UNPAID
      || !trialEntitlement(entitlement)) {
    return { status: 'skipped' };
  }

  const lifecycle = require('../payments/lifecycle');
  await lifecycle.rollbackUnprovisionedJellyfinTrial(customerId, entitlement.subscription_id, {
    reason: reason || 'Unpaid Jellyfin trial had no enabled server account'
  });
  // Clear stale provisioning state for the now no-plan result.
  await provisioning.reconcileCustomer(customerId);
  return { status: 'removed', subscriptionId: entitlement.subscription_id };
}

async function removeOrphanFreeAccount(customerId) {
  const before = await customerAccessState.freeJellyfin(customerId, { includeBlocked: true });
  if (before.state !== customerAccessState.ACCESS_STATES.ORPHAN_ACCOUNT) {
    return { status: 'skipped' };
  }

  await provisioning.reconcileCustomer(customerId);
  const after = await customerAccessState.freeJellyfin(customerId, { includeBlocked: true });
  if (after.state === customerAccessState.ACCESS_STATES.ORPHAN_ACCOUNT) {
    throw new Error('Free Server account remained after no-plan reconciliation.');
  }
  return { status: 'removed' };
}

module.exports = {
  trialEntitlement,
  repairFreeEntitlement,
  repairUnpaidTrial,
  removeOrphanFreeAccount
};
