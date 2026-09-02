'use strict';

const helpers = require('./provisioning-helpers');
const reconciliationLock = require('./reconciliation-lock');
const subscriptionExpiry = require('../entitlements/subscription-expiry');
const accessHolds = require('../entitlements/access-holds');

function safeLog(value, max = 500) {
  return String(value == null ? '' : value).replace(/[\r\n\t\u2028\u2029]+/g, ' ').slice(0, max);
}

// Compatibility facade: older platform code imports ./provisioning for helper
// functions as well as customer mutations. Low-level helper ownership now lives
// in provisioning-helpers, while all customer reconciliation mutations delegate
// to the canonical multi-service reconciler. resilient-provisioning imports the
// helper module directly, so this compatibility delegation no longer creates a
// circular module dependency.
function canonicalReconciler() { return require('./resilient-provisioning'); }
async function reconcileCustomer(customerId) { return canonicalReconciler().reconcileCustomer(customerId); }
async function reconcileAccount(accountId) { return canonicalReconciler().reconcileAccount(accountId); }

function adminHoldType(reason) {
  if (reason === 'disabled') return 'admin_disabled';
  if (reason === 'suspended') return 'admin_suspended';
  return 'admin_hold';
}

async function holdAccess(customerId, reason = 'suspended', actorUserId = null) {
  const type = adminHoldType(String(reason || 'suspended'));
  await accessHolds.addHold({
    customerId,
    type,
    sourceKey: 'admin',
    reason: String(reason || type).slice(0, 500),
    actorUserId
  });
  return reconcileCustomer(customerId);
}

async function releaseAccess(customerId, actorUserId = null) {
  await accessHolds.releaseAllAdminHolds(customerId, actorUserId);
  return reconcileCustomer(customerId);
}

async function maybeAutoDowngrade(customerId) {
  const lifecycle = require('../payments/lifecycle');
  try {
    return await lifecycle.autoDowngradeEligibleCustomer(customerId);
  } catch (error) {
    console.error('Automatic free-tier downgrade failed.', {
      customerId: safeLog(customerId, 100),
      error: safeLog(error?.message || error)
    });
    return null;
  }
}

async function notifyExpiringSubscriptions() {
  return subscriptionExpiry.notifyExpiringSubscriptions();
}

async function expireSubscriptionsAndReconcile() {
  return subscriptionExpiry.expireAndReconcile({
    reconcileCustomer,
    autoDowngrade: maybeAutoDowngrade,
    onReconcileError: (customerId, error) => console.error('Entitlement reconcile failed.', {
      customerId: safeLog(customerId, 100),
      error: safeLog(error?.message || error)
    })
  });
}

module.exports = {
  ...helpers,
  reconcileCustomer,
  reconcileAccount,
  holdAccess,
  releaseAccess,
  notifyExpiringSubscriptions,
  expireSubscriptionsAndReconcile,
  reconciliationLock
};
