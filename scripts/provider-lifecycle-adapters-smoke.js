'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const adapters = require('../src/payments/provider-lifecycle-adapters');
const billingControl = require('../src/payments/billing-control');

const noop = async () => {};
const valid = {
  fetchRemote: noop,
  stopRenewal: noop,
  resumeRenewal: noop,
  terminate: noop
};
assert.strictEqual(adapters.assertAdapter('test', valid), valid);
for (const method of adapters.REQUIRED_METHODS) {
  const incomplete = { ...valid };
  delete incomplete[method];
  assert.throws(
    () => adapters.assertAdapter('test', incomplete),
    new RegExp(method),
    `adapter contract must require ${method}`
  );
}

assert.strictEqual(adapters.providerMissing({ status: 404 }), true);
assert.strictEqual(adapters.providerMissing({ code: 'resource_missing' }), true);
assert.strictEqual(adapters.providerMissing(new Error('No such subscription: sub_missing')), true);
assert.strictEqual(adapters.providerMissing(new Error('timeout')), false);

const period = adapters.stripePeriod({
  items: { data: [{ current_period_end: 100 }, { current_period_end: 200 }] }
});
assert.strictEqual(period.getTime(), 200000);
assert.strictEqual(adapters.stripePriceId({ items: { data: [{ price: 'price_123' }] } }), 'price_123');
assert.strictEqual(adapters.stripePriceId({ items: { data: [{ price: { id: 'price_obj' } }] } }), 'price_obj');

const futureEnd = new Date('2026-11-01T00:00:00.000Z');
const paypalCancelled = billingControl.remoteStateForPolicy(
  { source: 'paypal', current_period_end: futureEnd },
  { status: 'CANCELLED', remoteStatus: 'CANCELLED', periodEnd: null, cancelAtPeriodEnd: true },
  { now: new Date('2026-10-01T00:00:00.000Z') }
);
assert.strictEqual(paypalCancelled.status, 'active',
  'central billing policy must preserve already-paid PayPal access through the local period end');
assert.strictEqual(paypalCancelled.remoteStatus, 'CANCELLED',
  'commercial interpretation must retain the provider fact for diagnostics');
assert.strictEqual(paypalCancelled.periodEnd.getTime(), futureEnd.getTime());

const paypalEnded = billingControl.remoteStateForPolicy(
  { source: 'paypal', current_period_end: new Date('2026-09-01T00:00:00.000Z') },
  { status: 'CANCELLED', remoteStatus: 'CANCELLED', periodEnd: null, cancelAtPeriodEnd: true },
  { now: new Date('2026-10-01T00:00:00.000Z') }
);
assert.strictEqual(paypalEnded.status, 'CANCELLED',
  'central billing policy must not extend PayPal access beyond the paid local period');

(async () => {
  await assert.rejects(adapters.forProvider('plisio'), /Unsupported recurring payment provider/);

  const root = path.join(__dirname, '..');
  const billing = fs.readFileSync(path.join(root, 'src/payments/billing-control.js'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src/payments/provider-lifecycle-adapters.js'), 'utf8');

  assert(billing.includes("require('./provider-contract')")
    && billing.includes('providerContract.recurring(provider)'),
    'billing policy must obtain remote lifecycle mechanics through the canonical provider contract');
  for (const transportDetail of [
    "require('stripe')",
    "require('./provider-settings')",
    "require('./provider-http')",
    '/v1/billing/subscriptions/',
    '/v1/oauth2/token'
  ]) {
    assert(!billing.includes(transportDetail),
      `billing policy must not own provider transport detail ${transportDetail}`);
  }
  assert(provider.includes("require('stripe')")
    && provider.includes('/v1/billing/subscriptions/')
    && provider.includes('/v1/oauth2/token'),
    'provider adapter module must own Stripe and PayPal remote lifecycle mechanics');
  assert(!provider.includes('new Date(row.current_period_end)'),
    'provider adapters must report provider facts rather than decide paid-period entitlement policy');
  assert(billing.includes('function remoteStateForPolicy')
    && billing.includes("providerContract.normalizeState('paypal'"),
    'billing control must centrally own PayPal paid-period interpretation while consuming normalized provider facts through the contract');

  console.log('provider lifecycle adapter smoke: ok');
})().catch(error => {
  console.error('provider lifecycle adapter smoke failed:', error);
  process.exit(1);
});
