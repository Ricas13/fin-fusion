'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const classifier = require('../src/payments/provider-transaction-classifier');
const live = require('../src/payments/live-stripe-payment-history');

const charge = {
  id: 'ch_resub_6',
  paid: true,
  status: 'succeeded',
  amount: 600,
  currency: 'usd',
  created: 1788582300,
  customer: 'cus_customer',
  payment_intent: {
    id: 'pi_3UC6AYLzChozTHix1WczQEu',
    metadata: {
      internal_customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      internal_plan_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
    }
  },
  invoice: 'in_new_plan',
  metadata: {}
};

const bt = {
  id: 'txn_balance',
  amount: 600,
  fee: 48,
  net: 552,
  currency: 'usd',
  status: 'available',
  created: 1788582300
};

const row = live.historyValues(charge, bt, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

assert.strictEqual(row.providerTransactionId, 'txn_balance');
assert.strictEqual(row.providerReferenceId, 'pi_3UC6AYLzChozTHix1WczQEu');
assert.strictEqual(row.providerSourceId, 'ch_resub_6');
assert.strictEqual(row.grossMinor, 600);
assert.strictEqual(row.feeMinor, 48);
assert.strictEqual(row.netMinor, 552);
assert.strictEqual(row.currency, 'USD');
assert.strictEqual(row.status, 'available');
assert.strictEqual(row.customerId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');

assert.strictEqual(
  classifier.classifyProviderTransaction({
    provider: 'stripe',
    type: 'charge',
    status: row.status,
    grossMinor: row.grossMinor
  }),
  'payment'
);

assert.strictEqual(live.historyValues({ ...charge, paid: false }, bt, null), null);
assert.strictEqual(live.historyValues(charge, { ...bt, amount: 0 }, null), null);
assert.strictEqual(live.historyValues(charge, { ...bt, fee: null, net: null }, null), null);
assert.strictEqual(live.historyValues(charge, { ...bt, id: null }, null), null);

const settlement = live.historyValues(
  { ...charge, amount: 400, currency: 'usd' },
  {
    ...bt,
    id: 'txn_fx',
    amount: 296,
    fee: 36,
    net: 260,
    currency: 'gbp'
  },
  null
);

assert.strictEqual(settlement.providerTransactionId, 'txn_fx');
assert.strictEqual(settlement.currency, 'GBP');
assert.strictEqual(settlement.grossMinor, 296);
assert.strictEqual(settlement.feeMinor, 36);
assert.strictEqual(settlement.netMinor, 260);

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/payments/live-stripe-payment-history.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'src/platform/admin-transactions.js'), 'utf8');

assert(source.includes("ON CONFLICT(provider,provider_transaction_id) DO UPDATE"));
assert(source.includes("transaction_type='charge'"));
assert(source.includes("expand: ['data.balance_transaction','data.payment_intent','data.invoice']"));
assert(source.includes('balanceTransactions.retrieve'));
assert(source.includes('providerAuthoritative: true'));
assert(source.includes('providerTransactionId: String(balanceTransaction.id)'));
assert(source.includes('providerSourceId: String(charge.id)'));
assert(source.includes('FROM legacy_subscription_imports'));
assert(!/INSERT\s+INTO\s+subscriptions/i.test(source));
assert(!/UPDATE\s+subscriptions/i.test(source));
assert(page.includes("require('../payments/live-stripe-payment-history')"));
assert(page.indexOf('await liveStripeHistory.syncRecent()') < page.indexOf('browser.listTransactions'));

const sequence = [
  { provider: 'stripe', transaction_type: 'charge', gross_amount_minor: 500 },
  { provider: 'stripe', transaction_type: 'refund', gross_amount_minor: -500 },
  { provider: 'stripe', transaction_type: 'charge', gross_amount_minor: 600 }
].map(item => classifier.historyKind(item));

assert.deepStrictEqual(sequence, ['payment','refund','payment']);

console.log('live Stripe payment history smoke: ok');
