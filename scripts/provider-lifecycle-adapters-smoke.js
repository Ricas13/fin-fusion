'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const adapters = require('../src/payments/provider-lifecycle-adapters');

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

(async () => {
  await assert.rejects(adapters.forProvider('plisio'), /Unsupported recurring payment provider/);

  const root = path.join(__dirname, '..');
  const billing = fs.readFileSync(path.join(root, 'src/payments/billing-control.js'), 'utf8');
  const provider = fs.readFileSync(path.join(root, 'src/payments/provider-lifecycle-adapters.js'), 'utf8');

  assert(billing.includes("require('./provider-lifecycle-adapters')")
    && billing.includes('providerAdapters.forProvider(provider)'),
    'billing policy must obtain remote lifecycle mechanics through the adapter contract');
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

  console.log('provider lifecycle adapter smoke: ok');
})().catch(error => {
  console.error('provider lifecycle adapter smoke failed:', error);
  process.exit(1);
});
