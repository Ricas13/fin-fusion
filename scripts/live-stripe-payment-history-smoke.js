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
    metadata: { internal_customer_id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', internal_plan_id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' }
  },
  invoice: 'in_new_plan',
  metadata: {}
};
const bt = { id: 'txn_balance', fee: 48, net: 552, currency: 'usd' };
const row = live.historyValues(charge, bt, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.strictEqual(row.providerTransactionId, 'ch_resub_6');
assert.strictEqual(row.providerReferenceId, 'pi_3UC6AYLzChozTHix1WczQEu', 'PaymentIntent must stay searchable without becoming the ledger dedupe key');
assert.strictEqual(row.grossMinor, 600, 'the re-subscription charge must appear as $6.00');
assert.strictEqual(row.feeMinor, 48, 'provider fee must come from the Stripe balance transaction');
assert.strictEqual(row.netMinor, 552, 'net proceeds must remain provider-authoritative');
assert.strictEqual(row.customerId, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'stripe', type: 'charge', status: row.status, grossMinor: row.grossMinor }), 'payment');
assert.strictEqual(live.historyValues({ ...charge, paid: false }, bt, null), null, 'unsuccessful charges must never become revenue');
assert.strictEqual(live.historyValues({ ...charge, amount: 0 }, bt, null), null, 'zero-value charges must never become revenue');
assert.strictEqual(live.historyValues(charge, { fee: null, net: null }, null), null, 'unknown fees/net must not be guessed');

const root = path.join(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'src/payments/live-stripe-payment-history.js'), 'utf8');
const page = fs.readFileSync(path.join(root, 'src/platform/admin-transactions.js'), 'utf8');
assert(source.includes("ON CONFLICT(provider,provider_transaction_id) DO UPDATE"), 'duplicate Stripe syncs must upsert rather than double count');
assert(source.includes("transaction_type='charge'"), 'live Stripe successes must use the canonical payment classification');
assert(source.includes("expand: ['data.balance_transaction','data.payment_intent','data.invoice']"), 'catch-up must request authoritative fee, PaymentIntent, and invoice data');
assert(source.includes('balanceTransactions.retrieve'), 'sync must recover authoritative fee/net if expansion is unavailable');
assert(source.includes('providerAuthoritative: true'), 'provider-verified rows must be distinguishable from synthetic legacy accounting');
assert(!/INSERT\s+INTO\s+subscriptions/i.test(source), 'accounting sync must never create entitlement state');
assert(!/UPDATE\s+subscriptions/i.test(source), 'accounting sync must never mutate entitlement state');
assert(page.includes("require('../payments/live-stripe-payment-history')"), 'Transactions must load the live Stripe catch-up service');
assert(page.indexOf('await liveStripeHistory.syncRecent()') < page.indexOf('browser.listTransactions'), 'Stripe catch-up must finish before the Transactions query renders');
assert(page.includes('very recent Stripe charges may be missing'), 'provider catch-up failures must be visible without hiding stored history');

// Regression sequence: a prior $5 payment can be refunded while a later $6
// payment remains a separate positive transaction. Charge ID is the unique
// payment identity, so the refund cannot suppress the new plan purchase.
const sequence = [
  { provider: 'stripe', transaction_type: 'charge', gross_amount_minor: 500 },
  { provider: 'stripe', transaction_type: 'refund', gross_amount_minor: -500 },
  { provider: 'stripe', transaction_type: 'charge', gross_amount_minor: 600 }
].map(item => classifier.historyKind(item));
assert.deepStrictEqual(sequence, ['payment','refund','payment']);

console.log('live Stripe payment history smoke: ok');
