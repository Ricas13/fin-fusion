'use strict';

const assert = require('assert');
const contract = require('../src/payments/provider-contract');
const refundAdapters = require('../src/payments/provider-refund-adapters');

assert.deepStrictEqual(contract.capabilities('stripe'), {
  provider: 'stripe',
  recurringLifecycle: true,
  refunds: true,
  oneTimeRemoteLookup: false
});
assert.deepStrictEqual(contract.capabilities('paypal'), {
  provider: 'paypal',
  recurringLifecycle: true,
  refunds: true,
  oneTimeRemoteLookup: false
});
assert.deepStrictEqual(contract.capabilities('plisio'), {
  provider: 'plisio',
  recurringLifecycle: false,
  refunds: false,
  oneTimeRemoteLookup: true
});

assert.deepStrictEqual(contract.state('stripe', 'active'), {
  provider: 'stripe',
  status: 'active',
  healthy: true,
  waiting: false,
  terminal: false
});
assert.deepStrictEqual(contract.state('paypal', 'CANCELLED'), {
  provider: 'paypal',
  status: 'CANCELLED',
  healthy: false,
  waiting: false,
  terminal: true
});
assert.deepStrictEqual(contract.state('plisio', 'completed'), {
  provider: 'plisio',
  status: 'completed',
  healthy: true,
  waiting: false,
  terminal: false
});

assert.strictEqual(refundAdapters.refundComplete('stripe', 'succeeded'), true);
assert.strictEqual(refundAdapters.refundComplete('stripe', 'pending'), false);
assert.strictEqual(refundAdapters.refundComplete('paypal', 'COMPLETED'), true);
assert.strictEqual(refundAdapters.refundComplete('paypal', 'PENDING'), false);

assert.strictEqual(contract.refunds('stripe').provider, 'stripe');
assert.strictEqual(contract.refunds('paypal').provider, 'paypal');
assert.throws(
  () => contract.refunds('plisio'),
  error => error?.code === 'PROVIDER_REFUND_UNSUPPORTED'
);

Promise.resolve()
  .then(() => contract.recurring('plisio'))
  .then(() => { throw new Error('Expected Plisio recurring lifecycle rejection.'); })
  .catch(error => {
    assert.strictEqual(error.code, 'PROVIDER_RECURRING_UNSUPPORTED');
    console.log('provider contract smoke: ok');
  });
