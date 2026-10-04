'use strict';

const customerAccessState = require('./customer-access-state');
const provisioning = require('../jellyfin/resilient-provisioning');

function trialEntitlement(entitlement) {
  return String(entitlement?.contract_billing_interval || entitlement?.billing_interval || '').toLowerCase() === 'trial';
}

function jellyfinEntitlement(entitlement) {
  return ['jellyfin', 'bundle'].includes(
    String(entitlement?.service_type_snapshot || entitlement?.service_type || 'jellyfin').toLowerCase()
  );
}

function automaticRollbackBlocker(access) {
  const entitlement = access?.entitlement || null;
  const accounts = Array.isArray(access?.accounts) ? access.accounts : [];
  if (!entitlement) return null;
  const assignedServerId = String(entitlement.media_server_id || entitlement.admin_forced_server_id || '').trim();
  if (assignedServerId && accounts.some(account => String(account?.server_id || '') === assignedServerId)) {
    return 'assigned_server_account_unavailable';
  }
  if (!assignedServerId && accounts.length > 1) {
    return 'ambiguous_legacy_assignment';
  }
  return null;
}

function createAccessRepair(deps = {}) {
  const accessState = deps.customerAccessState || customerAccessState;
  const provisioningApi = deps.provisioning || provisioning;
  const lifecycleApi = deps.lifecycle || (() => require('../payments/lifecycle'));
  const isOperatorProtected = deps.operatorProtected || customerAccessState.operatorProtected;

  async function repairFreeEntitlement(customerId, subscriptionId, { reason = null } = {}) {
    let access = await accessState.freeJellyfin(customerId, { includeBlocked: true });
    if (!access.entitlement || String(access.entitlement.subscription_id || '') !== String(subscriptionId || '')) {
      return { status: 'skipped', reason: 'subscription_changed' };
    }
    if (access.state === accessState.ACCESS_STATES.ACTIVE_BLOCKED) {
      return { status: 'skipped', reason: 'blocked' };
    }
    if (access.state === accessState.ACCESS_STATES.ACTIVE_READY) {
      return { status: 'ready', account: access.account };
    }
    const initialBlocker = automaticRollbackBlocker(access);
    if (initialBlocker === 'ambiguous_legacy_assignment') {
      return { status: 'protected', reason: initialBlocker };
    }

    let reconcileError = null;
    try {
      await provisioningApi.reconcileCustomer(customerId);
    } catch (error) {
      reconcileError = error;
    }

    access = await accessState.freeJellyfin(customerId, { includeBlocked: true });
    if (access.entitlement
        && String(access.entitlement.subscription_id || '') === String(subscriptionId || '')
        && access.state === accessState.ACCESS_STATES.ACTIVE_READY) {
      return { status: 'repaired', account: access.account };
    }

    // Re-check exact ownership after reconciliation. A replacement subscription
    // must never be rolled back while repairing an older Free access episode.
    if (!access.entitlement || String(access.entitlement.subscription_id || '') !== String(subscriptionId || '')) {
      return { status: 'skipped', reason: 'subscription_changed_after_reconcile' };
    }
    if (access.state === accessState.ACCESS_STATES.ACTIVE_BLOCKED) {
      return { status: 'skipped', reason: 'blocked_after_reconcile' };
    }
    const rollbackBlocker = automaticRollbackBlocker(access);
    if (rollbackBlocker) {
      return { status: 'protected', reason: rollbackBlocker, reconcileError };
    }
    if (isOperatorProtected(access.entitlement)) {
      // Permanent Access and explicit administrator-present are stronger than
      // automatic repair policy. If provisioning cannot restore the account,
      // retain the entitlement for retry/manual intervention instead of
      // converting an operator-protected access episode into a cancellation.
      return { status: 'protected', reason: 'admin_protected', reconcileError };
    }

    const lifecycle = lifecycleApi();
    await lifecycle.rollbackUnprovisionedFreeClaim(customerId, subscriptionId, {
      reason: reconcileError?.message || reason || 'Free entitlement had no enabled Free Server account'
    });
    return { status: 'removed', reconcileError };
  }

  async function repairUnpaidTrial(customerId, { reason = null } = {}) {
    const access = await accessState.primaryJellyfin(customerId, { includeBlocked: true });
    const entitlement = access.entitlement;
    if (!entitlement
        || access.state !== accessState.ACCESS_STATES.INCONSISTENT_UNPAID
        || !trialEntitlement(entitlement)
        || !jellyfinEntitlement(entitlement)) {
      return { status: 'skipped' };
    }

    const rollbackBlocker = automaticRollbackBlocker(access);
    if (rollbackBlocker) {
      return { status: 'protected', reason: rollbackBlocker, subscriptionId: entitlement.subscription_id };
    }
    if (isOperatorProtected(entitlement)) {
      return { status: 'protected', reason: 'admin_protected', subscriptionId: entitlement.subscription_id };
    }

    const lifecycle = lifecycleApi();
    await lifecycle.rollbackUnprovisionedJellyfinTrial(customerId, entitlement.subscription_id, {
      reason: reason || 'Unpaid Jellyfin trial had no enabled server account'
    });

    // Converge the now no-plan state so stale provisioning metadata does not
    // keep advertising a deployment for an entitlement that was rolled back.
    await provisioningApi.reconcileCustomer(customerId);
    return { status: 'removed', subscriptionId: entitlement.subscription_id };
  }

  async function removeOrphanFreeAccount(customerId) {
    const before = await accessState.freeJellyfin(customerId, { includeBlocked: true });
    if (before.state !== accessState.ACCESS_STATES.ORPHAN_ACCOUNT) {
      return { status: 'skipped' };
    }

    await provisioningApi.reconcileCustomer(customerId);
    const after = await accessState.freeJellyfin(customerId, { includeBlocked: true });
    if (after.state === accessState.ACCESS_STATES.ORPHAN_ACCOUNT) {
      throw new Error('Free Server account remained after no-plan reconciliation.');
    }
    return { status: 'removed' };
  }

  async function repairIntegrityFinding(finding) {
    const kind = String(finding?.kind || '');
    const customerId = finding?.customerId || finding?.customer_id || null;
    if (!customerId) {
      const error = new Error('Access integrity finding is missing its customer identity.');
      error.code = 'ACCESS_INTEGRITY_REPAIR_INVALID_FINDING';
      throw error;
    }

    if (kind === 'free_plan_without_ready_server') {
      return repairFreeEntitlement(customerId, finding.id, {
        reason: 'Access Integrity repair: live Free plan had no ready Free Server account'
      });
    }
    if (kind === 'free_server_without_plan') {
      return removeOrphanFreeAccount(customerId);
    }
    if (kind === 'unpaid_trial_without_ready_server') {
      return repairUnpaidTrial(customerId, {
        reason: 'Access Integrity repair: unpaid Jellyfin trial had no ready primary account'
      });
    }

    const error = new Error(`Access integrity finding ${kind || '(unknown)'} requires manual review and is not eligible for automatic repair.`);
    error.code = 'ACCESS_INTEGRITY_REPAIR_MANUAL_REVIEW';
    throw error;
  }

  return {
    repairFreeEntitlement,
    repairUnpaidTrial,
    removeOrphanFreeAccount,
    repairIntegrityFinding
  };
}

const defaultRepair = createAccessRepair();

module.exports = {
  trialEntitlement,
  jellyfinEntitlement,
  automaticRollbackBlocker,
  createAccessRepair,
  ...defaultRepair
};
