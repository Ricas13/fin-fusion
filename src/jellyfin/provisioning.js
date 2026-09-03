'use strict';

const helpers = require('./provisioning-helpers');
const reconciliationLock = require('./reconciliation-lock');
const subscriptionExpiry = require('../entitlements/subscription-expiry');

// Compatibility facade: older platform code imports ./provisioning for helper
// functions as well as customer mutations. Low-level helper ownership lives in
// provisioning-helpers, while every customer mutation delegates to the canonical
// multi-service reconciler. The reconciler imports helpers directly, so this
// compatibility surface cannot become part of a circular dependency again.
function canonicalReconciler() { return require('./resilient-provisioning'); }
async function reconcileCustomer(customerId) { return canonicalReconciler().reconcileCustomer(customerId); }
async function reconcileAccount(accountId) { return canonicalReconciler().reconcileAccount(accountId); }
async function holdAccess(customerId, reason = 'suspended', actorUserId = null) {
  return canonicalReconciler().holdAccess(customerId, reason, actorUserId);
}
async function releaseAccess(customerId, actorUserId = null) {
  return canonicalReconciler().releaseAccess(customerId, actorUserId);
}
async function expireSubscriptionsAndReconcile() {
  return canonicalReconciler().expireSubscriptionsAndReconcile();
}
async function notifyExpiringSubscriptions() {
  return subscriptionExpiry.notifyExpiringSubscriptions();
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
