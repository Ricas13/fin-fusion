'use strict';

const { query } = require('../db');
const provisioning = require('./resilient-provisioning');
const control = require('./reconciliation-control');

function noCapacity(error) {
  return /no eligible jellyfin server|no jellyfin server is currently available/i.test(String(error?.message || error || ''));
}

async function hasReadyFreeAccount(customerId) {
  const result = await query(`
    SELECT 1
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1
      AND ja.account_purpose='jellyfin'
      AND ja.access_lane='free'
      AND ja.disabled=FALSE
      AND js.enabled=TRUE
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    LIMIT 1
  `, [customerId]);
  return result.rowCount > 0;
}

async function ensureFreeClaimReady(customerId, { attempts = 1 } = {}) {
  if (await hasReadyFreeAccount(customerId)) {
    return { ready: true, attempts: 0, error: null };
  }

  const priorState = await control.getCustomerState(customerId).catch(() => null);
  await control.forceCustomerDue(customerId);

  // claimFreePlan() already performed one immediate reconciliation attempt.
  // If that attempt proved there is currently no eligible server capacity,
  // do not hammer Jellyfin again in the same HTTP request. The dedicated
  // 30-second free_capacity_backfill job owns vacancy recovery.
  if (noCapacity(priorState?.last_error)) {
    return {
      ready: false,
      attempts: 0,
      error: new Error(priorState.last_error)
    };
  }

  const maxAttempts = Math.max(0, Math.min(2, Number(attempts) || 0));
  let lastError = priorState?.last_error ? new Error(priorState.last_error) : null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await provisioning.reconcileCustomer(customerId);
      if (await hasReadyFreeAccount(customerId)) {
        return { ready: true, attempts: attempt, error: null };
      }
      lastError = new Error('Free Server entitlement reconciled without creating an enabled Free Server account.');
      lastError.code = 'FREE_CLAIM_ACCOUNT_MISSING';
    } catch (error) {
      lastError = error;
      if (noCapacity(error)) break;
    }
  }

  // Reconciliation may have classified the failure with a normal delayed
  // retry. Keep this newly claimed customer immediately due so the single
  // Free Server backfill worker can retry on its next 30-second pass.
  await control.forceCustomerDue(customerId).catch(() => {});
  return { ready: false, attempts: maxAttempts, error: lastError };
}

module.exports = { hasReadyFreeAccount, ensureFreeClaimReady, noCapacity };
