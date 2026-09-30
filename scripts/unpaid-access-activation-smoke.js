'use strict';

const assert = require('assert');
const { activateOrRollback } = require('../src/payments/unpaid-access-activation');

(async () => {
  {
    let rollbackCalls = 0;
    const ready = { id: 'account-1' };
    const result = await activateOrRollback({
      customerId: 'customer-1',
      subscriptionId: 'subscription-1',
      reconcile: async () => {},
      verify: async () => ready,
      rollback: async () => { rollbackCalls += 1; },
      missingReason: 'missing',
      failureMessage: 'failed',
      failureCode: 'FAILED'
    });
    assert.strictEqual(result.ready, ready, 'successful unpaid activation must return the verified account');
    assert.strictEqual(rollbackCalls, 0, 'successful unpaid activation must never roll back');
  }

  {
    let rollbackCalls = 0;
    const ready = { id: 'account-after-timeout' };
    const result = await activateOrRollback({
      customerId: 'customer-2',
      subscriptionId: 'subscription-2',
      reconcile: async () => { throw new Error('response timeout'); },
      verify: async () => ready,
      rollback: async () => { rollbackCalls += 1; },
      missingReason: 'missing',
      failureMessage: 'failed',
      failureCode: 'FAILED'
    });
    assert.strictEqual(result.ready, ready, 'postcondition verification must win over a reconciliation response error');
    assert.strictEqual(rollbackCalls, 0, 'verified access after an ambiguous reconcile must not be rolled back');
  }

  {
    const rollback = [];
    const reconcileFailure = new Error('no server capacity');
    await assert.rejects(
      activateOrRollback({
        customerId: 'customer-3',
        subscriptionId: 'subscription-3',
        reconcile: async () => { throw reconcileFailure; },
        verify: async () => null,
        rollback: async (customerId, subscriptionId, options) => rollback.push({ customerId, subscriptionId, options }),
        rollbackOptions: { reservationId: 'reservation-3' },
        missingReason: 'missing',
        failureMessage: 'No unpaid access retained.',
        failureCode: 'UNPAID_ACTIVATION_FAILED'
      }),
      error => error.code === 'UNPAID_ACTIVATION_FAILED'
        && error.cause === reconcileFailure
        && error.message === 'No unpaid access retained.',
      'failed unpaid activation must expose the stable public failure code and preserve the reconcile cause'
    );
    assert.deepStrictEqual(rollback, [{
      customerId: 'customer-3',
      subscriptionId: 'subscription-3',
      options: { reservationId: 'reservation-3', reason: 'no server capacity' }
    }], 'failed activation must roll back the exact subscription with the original reconcile reason');
  }

  {
    const rollback = [];
    await assert.rejects(
      activateOrRollback({
        customerId: 'customer-4',
        subscriptionId: 'subscription-4',
        reconcile: async () => {},
        verify: async () => null,
        rollback: async (_customerId, _subscriptionId, options) => rollback.push(options),
        missingReason: 'verification found no enabled account',
        failureMessage: 'failed',
        failureCode: 'FAILED'
      }),
      error => error.code === 'FAILED'
    );
    assert.strictEqual(rollback[0].reason, 'verification found no enabled account',
      'postcondition failure without a reconcile error must use the explicit missing-account reason');
  }

  console.log('unpaid access activation smoke: ok');
})().catch(error => {
  console.error('unpaid access activation smoke failed:', error);
  process.exit(1);
});
