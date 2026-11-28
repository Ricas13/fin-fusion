'use strict';

const customerAccessState = require('./customer-access-state');
const provisioning = require('../jellyfin/resilient-provisioning');
const mediaReconciliation = require('../jellyfin/media-service-reconciliation');
const { isLockTimeoutError } = require('../jellyfin/lock-errors');

// Avoid duplicate secondary-service repair attempts while a new trial is being
// provisioned. This grace period is never a cancellation deadline.
const UNPAID_TRIAL_REPAIR_GRACE_MS = 15 * 60 * 1000;

// A lock timeout means the work never ran, so repair has learned nothing about
// this customer. Leave everything in place for a later pass.
const DEFERRED_LOCK_TIMEOUT = Object.freeze({ status: 'deferred', reason: 'lock_timeout' });

// Rollbacks re-check under the customer lock and may decline to change anything.
function skippedRollbackOutcome(result) {
  if (result?.rolledBack !== false) return null;
  return { status: result.reason === 'ready' ? 'ready' : 'skipped', reason: result.reason };
}

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

// PostgreSQL 'infinity' (permanent or administrator-granted access).
function neverExpires(value) {
  return value === Infinity || String(value).toLowerCase() === 'infinity';
}

function createAccessRepair(deps = {}) {
  const accessState = deps.customerAccessState || customerAccessState;
  const provisioningApi = deps.provisioning || provisioning;
  const lifecycleApi = deps.lifecycle || (() => require('../payments/lifecycle'));
  const isOperatorProtected = deps.operatorProtected || customerAccessState.operatorProtected;
  const mediaApi = deps.mediaReconciliation || mediaReconciliation;
  const now = deps.now || Date.now;
  const graceMs = deps.graceMs ?? UNPAID_TRIAL_REPAIR_GRACE_MS;

  // subscription_created_at/starts_at only: plan columns overwrite created_at in
  // the entitlement rows.
  function startedRecently(entitlement) {
    const started = new Date(entitlement?.subscription_created_at || entitlement?.starts_at || NaN).getTime();
    return Number.isFinite(started) && now() - started < graceMs;
  }

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
    if (isLockTimeoutError(reconcileError)) {
      return { ...DEFERRED_LOCK_TIMEOUT, reconcileError };
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
    let result;
    try {
      result = await lifecycle.rollbackUnprovisionedFreeClaim(customerId, subscriptionId, {
        reason: reconcileError?.message || reason || 'Free entitlement had no enabled Free Server account',
        retainBlocked: true
      });
    } catch (error) {
      if (isLockTimeoutError(error)) return { ...DEFERRED_LOCK_TIMEOUT, reconcileError };
      throw error;
    }
    const skipped = skippedRollbackOutcome(result);
    if (skipped) return { ...skipped, reconcileError };
    return { status: 'removed', reconcileError };
  }

  async function repairUnpaidTrial(customerId, { reason = null, cause = null } = {}) {
    if (isLockTimeoutError(cause)) return { ...DEFERRED_LOCK_TIMEOUT };

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
    // Provisioning failure is never authority to cancel an unpaid trial.
    // The worker retains its backoff and the integrity finding stays visible.
    return { status: 'deferred', reason: 'manual_review_required', subscriptionId: entitlement.subscription_id };
  }

  // Emby and Stremio have no ACTIVE_READY lane state, so each applies the same
  // readiness check its activation uses.
  async function repairUnpaidEmbyTrial(customerId, entitlement, options) {
    const lifecycle = lifecycleApi();
    const subscriptionId = entitlement.subscription_id;
    if (await lifecycle.readyEmbyAccountForSubscription(customerId, subscriptionId)) return { status: 'ready' };
    const blockerFor = async candidate => automaticRollbackBlocker({
      entitlement: candidate,
      accounts: await mediaApi.accountsFor(customerId, 'emby')
    });
    let blocker = await blockerFor(entitlement);
    if (blocker) return { status: 'protected', reason: blocker };

    // Reconciliation runs Emby after the Jellyfin lanes, so an earlier failure
    // can mean Emby was never attempted. Give it its own attempt first.
    let convergeError = null;
    try {
      await provisioningApi.reconciliationLock.withCustomerReconciliationLock(
        customerId,
        () => mediaApi.reconcileCustomer(customerId, 'emby')
      );
    } catch (error) {
      if (isLockTimeoutError(error)) return { ...DEFERRED_LOCK_TIMEOUT };
      convergeError = error;
    }
    if (await lifecycle.readyEmbyAccountForSubscription(customerId, subscriptionId)) return { status: 'repaired' };

    const after = await accessState.emby(customerId, { includeBlocked: true });
    if (String(after.entitlement?.subscription_id || '') !== String(subscriptionId || '')) {
      return { status: 'skipped', reason: 'subscription_changed_after_reconcile' };
    }
    blocker = await blockerFor(after.entitlement);
    if (blocker) return { status: 'protected', reason: blocker };

    return { status: 'deferred', reason: 'manual_review_required', reconcileError: convergeError };
  }

  async function repairUnpaidStremioTrial(customerId, entitlement, options) {
    const lifecycle = lifecycleApi();
    const subscriptionId = entitlement.subscription_id;
    const bundle = String(entitlement.service_type_snapshot || entitlement.service_type || '').toLowerCase() === 'bundle';
    if (bundle) {
      if (await lifecycle.readyJellyfinBundleForSubscription(customerId, subscriptionId)) return { status: 'ready' };
      // The Jellyfin half gets the same protections as Jellyfin trial repair.
      const primary = await accessState.primaryJellyfin(customerId, { includeBlocked: true });
      if (String(primary.entitlement?.subscription_id || '') === String(subscriptionId || '')) {
        // A missing installation link never justifies deleting a working account.
        if (primary.state === accessState.ACCESS_STATES.ACTIVE_READY) {
          return { status: 'protected', reason: 'media_account_ready' };
        }
        if (primary.state === accessState.ACCESS_STATES.ACTIVE_BLOCKED) return { status: 'skipped', reason: 'blocked' };
        const blocker = automaticRollbackBlocker(primary);
        if (blocker) return { status: 'protected', reason: blocker };
        if (isOperatorProtected(primary.entitlement)) return { status: 'protected', reason: 'admin_protected' };
      }
    } else {
      if (await lifecycle.readyStremioInstallForSubscription(customerId, subscriptionId)) return { status: 'ready' };
    }
    return { status: 'deferred', reason: 'manual_review_required' };
  }

  async function repairUnpaidServiceTrial(customerId, service, { reason = null, cause = null } = {}) {
    const lane = String(service || '').trim().toLowerCase();
    if (!['emby', 'stremio'].includes(lane)) {
      throw new Error(`Unsupported unpaid service trial lane: ${lane || '(empty)'}`);
    }
    if (isLockTimeoutError(cause)) return { ...DEFERRED_LOCK_TIMEOUT };

    const access = await accessState[lane](customerId, { includeBlocked: true });
    const entitlement = access.entitlement;
    // Only locally-started trials: never an add-on or provider-billed access.
    if (!entitlement
        || access.state !== accessState.ACCESS_STATES.ACTIVE_ENTITLED
        || !trialEntitlement(entitlement)
        || entitlement.is_addon
        || String(entitlement.source || '') !== 'manual') {
      return { status: 'skipped' };
    }
    const subscriptionId = entitlement.subscription_id;
    if (isOperatorProtected(entitlement) || neverExpires(entitlement.access_expires_at)) {
      return { status: 'protected', reason: 'admin_protected', subscriptionId };
    }
    if (startedRecently(entitlement)) {
      return { status: 'deferred', reason: 'activation_grace', subscriptionId };
    }

    const options = {
      reason: reason || `Unpaid ${lane === 'emby' ? 'Emby' : 'Stremio'} trial had no working access`,
      retainBlocked: true
    };
    const repairLane = lane === 'emby' ? repairUnpaidEmbyTrial : repairUnpaidStremioTrial;
    try {
      return { ...await repairLane(customerId, entitlement, options), subscriptionId };
    } catch (error) {
      if (isLockTimeoutError(error)) return { ...DEFERRED_LOCK_TIMEOUT, subscriptionId };
      throw error;
    }
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
    repairUnpaidServiceTrial,
    removeOrphanFreeAccount,
    repairIntegrityFinding
  };
}

const defaultRepair = createAccessRepair();

module.exports = {
  UNPAID_TRIAL_REPAIR_GRACE_MS,
  trialEntitlement,
  jellyfinEntitlement,
  automaticRollbackBlocker,
  createAccessRepair,
  ...defaultRepair
};
