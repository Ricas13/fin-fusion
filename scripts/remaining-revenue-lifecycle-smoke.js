'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const expiry = require('../src/entitlements/subscription-expiry');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const section = (text, start, end) => {
  const from = text.indexOf(start);
  assert(from >= 0, `Missing source marker ${start}`);
  const to = end ? text.indexOf(end, from + start.length) : text.length;
  return text.slice(from, to < 0 ? text.length : to);
};

assert.strictEqual(expiry.providerVerificationGraceHours(undefined), expiry.DEFAULT_PROVIDER_VERIFICATION_GRACE_HOURS);
assert.strictEqual(expiry.providerVerificationGraceHours('0'), 1, 'provider-verification grace must retain a minimum outage cushion');
assert.strictEqual(expiry.providerVerificationGraceHours('999'), 168, 'provider-verification grace must not become an accidental indefinite extension');

const due = {
  id: '11111111-1111-4111-8111-111111111111',
  source: 'stripe',
  current_period_end: '2026-09-01T00:00:00.000Z',
  service_extension_days: 0
};
assert.strictEqual(expiry.failedProviderVerificationProtected(due, { now: '2026-09-02T23:59:59.000Z', graceHours: 48 }), true,
  'a short provider outage at renewal must fail closed inside the bounded safety window');
assert.strictEqual(expiry.failedProviderVerificationProtected(due, { now: '2026-09-03T00:00:01.000Z', graceHours: 48 }), false,
  'provider verification failure must not preserve unpaid access forever after the bounded grace');
const extended = { ...due, service_extension_days: 2 };
assert.strictEqual(expiry.failedProviderVerificationProtected(extended, { now: '2026-09-04T23:59:59.000Z', graceHours: 48 }), true,
  'service-credit time must remain part of the local paid-access end before verification grace starts');
assert.strictEqual(expiry.providerExpiryProtected(due, { ok: true, remote: { status: 'active', cancelAtPeriodEnd: false } }, { now: '2026-09-02T00:00:00Z', graceHours: 48 }), true,
  'an active recurring agreement protects a renewal that is only just late (the charge may still be settling)');
assert.strictEqual(expiry.providerExpiryProtected(due, { ok: true, remote: { status: 'active', cancelAtPeriodEnd: false } }, { now: '2026-09-10T00:00:00Z', graceHours: 48 }), false,
  'an agreement the provider still calls active must NOT keep a term alive forever once it is past the bounded grace without a renewed paid-through date');
assert.strictEqual(expiry.providerExpiryProtected(due, { ok: true, remote: { status: 'canceled', cancelAtPeriodEnd: true } }, { now: '2026-09-01T01:00:00Z', graceHours: 48 }), false,
  'provider-confirmed cancellation must never be hidden by the outage grace');

const expirySource = read('src/entitlements/subscription-expiry.js');
const expireScope = section(expirySource, 'async function expireDueSubscriptions', 'async function expireAndReconcile');
assert(expireScope.includes('recordExpiryVerificationFailure(row, verificationError'),
  'exhausted provider verification must create durable operator-visible evidence');
assert(expireScope.indexOf('recordExpiryVerificationFailure(row, verificationError') < expireScope.indexOf("SET status='expired'"),
  'provider ambiguity must be recorded before local commercial expiry is committed');
assert(expirySource.includes("kind: 'failed_renewal'") && expirySource.includes("reason: 'expiry_provider_verification_exhausted'"),
  'provider-verification exhaustion must use the canonical payment incident surface');

const incidents = read('src/payments/incidents.js');
assert(incidents.includes("const confirmedLostChargeback=kind==='chargeback'&&(status==='lost'||incident.incident_status==='lost')"),
  'provider loss regression depends on the canonical confirmed-lost chargeback terminal rule');
assert(incidents.includes('subscriptionTermination.terminateForRefund'),
  'confirmed provider loss must continue through the canonical subscription termination owner');

console.log('remaining revenue lifecycle smoke: ok');
