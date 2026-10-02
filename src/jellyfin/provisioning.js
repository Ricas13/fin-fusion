'use strict';

const helpers = require('./provisioning-helpers');
const reconciliationLock = require('./reconciliation-lock');
const subscriptionExpiry = require('../entitlements/subscription-expiry');

// Backward-compatible import surface only. Customer mutations still delegate to
// the canonical resilient multi-service reconciler, so this file contains no
// second provisioning policy or state machine.
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
