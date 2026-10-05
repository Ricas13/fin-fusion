'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const paypal = require('../src/payments/paypal');
const reconciliation = require('../src/payments/provider-payment-reconciliation');
const classifier = require('../src/payments/provider-transaction-classifier');

const recurring = {
  id: '51469559GP3271839',
  status: 'COMPLETED',
  time: '2026-10-05T11:06:48Z',
  amount_with_breakdown: {
    gross_amount: { currency_code: 'USD', value: '30.00' },
    fee_amount: { currency_code: 'USD', value: '-1.47' },
    net_amount: { currency_code: 'USD', value: '28.53' }
  }
};

assert.deepStrictEqual(paypal.paypalSubscriptionTransactionAmounts(recurring), {
  grossMinor: 3000,
  feeMinor: 147,
  netMinor: 2853,
  currency: 'USD',
  feeDataAvailable: true
});

assert.strictEqual(
  classifier.classifyProviderTransaction({
    provider: 'paypal',
    type: 'T0002',
    status: 'S',
    grossMinor: 3000
  }),
  'payment',
  'PayPal recurring subscription payments must remain revenue-classified'
);

assert.strictEqual(
  reconciliation.paypalSubscriptionReference({ referenceType: 'SUB', referenceId: 'I-2EK4NRSN93VR' }),
  'I-2EK4NRSN93VR'
);
assert.strictEqual(
  reconciliation.paypalSubscriptionReference({ referenceType: 'ODR', referenceId: 'I-2EK4NRSN93VR' }),
  null,
  'order references must never be mistaken for billing subscription ownership'
);

assert.deepStrictEqual(
  reconciliation.paypalReportingFinancials({
    transaction_amount: { currency_code: 'USD', value: '30.00' },
    fee_amount: { currency_code: 'USD', value: '-1.47' }
  }),
  {
    amountMinor: 3000,
    feeMinor: 147,
    netMinor: 2853,
    currency: 'USD',
    feeDataAvailable: true
  }
);

assert.deepStrictEqual(
  reconciliation.paypalReportingFinancials({
    transaction_amount: { currency_code: 'USD', value: '30.00' }
  }),
  {
    amountMinor: 3000,
    feeMinor: 0,
    netMinor: 3000,
    currency: 'USD',
    feeDataAvailable: false
  },
  'missing fee data must stay non-authoritative so a later provider sync can improve it'
);

const window = paypal.paypalSubscriptionTransactionWindow(
  '2026-10-05T11:06:48Z',
  new Date('2026-10-05T13:00:00Z')
);
assert.strictEqual(window.start, '2026-10-03T23:06:48.000Z');
assert.strictEqual(window.end, '2026-10-05T13:00:00.000Z');

const root = path.join(__dirname, '..');
const paypalSource = fs.readFileSync(path.join(root, 'src/payments/paypal.js'), 'utf8');
const reconciliationSource = fs.readFileSync(path.join(root, 'src/payments/provider-payment-reconciliation.js'), 'utf8');

assert(
  paypalSource.includes('/v1/billing/subscriptions/') && paypalSource.includes('/transactions?start_time='),
  'subscription-payment success must have a provider-backed transaction lookup fallback'
);
assert(
  paypalSource.includes('if(!liveRecord.recorded&&synced.row?.customer_id)'),
  'subscription-payment webhook must repair the ledger when its event lacks a transaction-shaped resource'
);
assert(
  reconciliationSource.includes("referenceType: 'SUB'"),
  'Transaction Search reconciliation must preserve PayPal subscription references'
);
assert(
  reconciliationSource.includes('syncReportedPayPalSubscriptionPayments(remote.rows'),
  'scheduled PayPal reconciliation must ingest recurring subscription receipts'
);
assert(
  reconciliationSource.includes('ambiguousSubscriptionIds') &&
  reconciliationSource.includes('group.customerIds.size !== 1'),
  'scheduled PayPal reconciliation must fail closed when one provider subscription ID maps to multiple local customers'
);
assert(
  reconciliationSource.includes("row.eventCode === livePaypalHistory.LIVE_CAPTURE_PAYMENT_TYPE && !paypalSubscriptionReference(row)"),
  'one-time capture lookup and recurring subscription reconciliation must remain separate'
);

console.log('PayPal subscription payment ledger smoke: ok');
