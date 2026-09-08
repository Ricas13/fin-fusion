'use strict';

const assert = require('assert');
const ownerGuard = require('../src/auth/owner-guard');
const { restrictedImpersonationAction } = require('../src/platform/admin-impersonation');

// Owner authorization must be anchored to canonical auth identity. The legacy
// numeric adminId is compatibility/UI state and must not decide whether a real
// admin session can reach the authoritative database is_owner check.
assert.strictEqual(ownerGuard.isAdminSession({ session: { authUserId: 'user-1', authRole: 'admin' } }), true, 'canonical admin session must not require legacy adminId');
assert.strictEqual(ownerGuard.isAdminSession({ session: { authUserId: 'user-1', authRole: 'customer', adminId: 7 } }), false, 'legacy adminId must never make a customer session administrative');
assert.strictEqual(ownerGuard.isAdminSession({ session: { authRole: 'admin', adminId: 7 } }), false, 'admin role without canonical authUserId must fail closed');

// Impersonation is an owner acting on behalf of the customer, not a read-only
// preview. Future ordinary account mutations stay usable, while financial
// namespaces fail closed unless explicitly classified as a safe cancellation.
const impersonated = (method,path='/account/future-feature/ordinary-mutation',body={}) => ({ session: { impersonation: { id: 'imp-1' }, authRole: 'customer' }, method, path, body });
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  assert.strictEqual(restrictedImpersonationAction(impersonated(method)), null, `${method} ordinary account mutations must remain available while impersonating`);
}
for (const path of [
  '/account/billing/future-provider-action',
  '/account/payment/future-method',
  '/account/payments/future-method',
  '/account/payment-method/future-method',
  '/account/payment-methods/future-method',
  '/account/purchase/future-product',
  '/account/upgrade/future-plan',
  '/account/add-on/future-addon',
  '/account/add-ons/future-addon'
]) {
  assert.strictEqual(restrictedImpersonationAction(impersonated('POST',path)), 'spending', `future financial mutation must fail closed while impersonating: ${path}`);
}
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/checkout/stripe')), 'spending', 'checkout creation must remain blocked while impersonating');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/checkout/cancel-open')), null, 'checkout cancellation must remain available while impersonating');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/subscription/renewal',{action:'stop'})), null, 'stopping renewal must remain available while impersonating');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/subscription/renewal',{action:'resume'})), 'spending', 'resuming renewal must remain blocked while impersonating');
assert.strictEqual(restrictedImpersonationAction(impersonated('GET')), null, 'customer browsing must remain available while impersonating');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/impersonation/exit')), null, 'explicit impersonation exit must remain available');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/affiliate/redeem')), 'spending', 'redeeming affiliate/referral credit spends a real balance and activates a subscription -- must fail closed while impersonating');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/stripe/portal')), 'spending', 'the Stripe customer portal lets a customer change payment methods and recurring billing directly with the provider -- must fail closed while impersonating');

console.log('Grok auth hardening behavior smoke: OK');