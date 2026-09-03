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

// Impersonation is already method-level read-only. Prove an arbitrary future
// account mutation is denied without having to enumerate its route name.
const impersonated = method => ({ session: { impersonation: { id: 'imp-1' }, authRole: 'customer' }, method, path: '/account/future-feature/unsafe-mutation' });
for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
  assert.strictEqual(restrictedImpersonationAction(impersonated(method)), 'customer changes', `${method} must be denied while impersonating even for a route unknown to this test`);
}
assert.strictEqual(restrictedImpersonationAction(impersonated('GET')), null, 'read-only customer browsing must remain available while impersonating');
assert.strictEqual(restrictedImpersonationAction({ session: { impersonation: { id: 'imp-1' }, authRole: 'customer' }, method: 'POST', path: '/account/impersonation/exit' }), null, 'explicit impersonation exit must remain available');

console.log('Grok auth hardening behavior smoke: OK');
