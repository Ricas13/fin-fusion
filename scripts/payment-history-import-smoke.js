'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const history = require('../src/payments/history-import');

const leap = history.parseRange({ provider: 'both', startDate: '2024-01-01', endDate: '2024-12-31' });
assert.strictEqual(leap.days, 366, 'a leap-year import must fit the 366-day safety limit');
assert.throws(() => history.parseRange({ provider: 'stripe', startDate: '2024-01-01', endDate: '2025-01-01' }), /limited to 366 days/);
assert.throws(() => history.parseRange({ provider: 'other', startDate: '2026-01-01', endDate: '2026-01-31' }), /Choose Stripe/);

const windows = history.payPalWindows(new Date('2026-01-01T00:00:00.000Z'), new Date('2027-01-01T00:00:00.000Z'));
assert.ok(windows.length > 1, 'PayPal annual history must be split into multiple provider-safe windows');
for (const window of windows) {
    assert.ok((window.end.getTime() - window.start.getTime()) < 31 * 24 * 60 * 60 * 1000, 'PayPal window must not exceed 31 days');
}
assert.strictEqual(windows[0].start.toISOString(), '2026-01-01T00:00:00.000Z');
assert.strictEqual(windows[windows.length - 1].end.toISOString(), '2026-12-31T23:59:59.999Z');

const stripe = history.normalizeStripe({ id: 'txn_1', created: 1767225600, amount: 1000, fee: 59, net: 941, currency: 'gbp', reporting_category: 'charge', status: 'available', source: 'ch_1' }, new Map([['ch_1', { customer: 'cus_1', payment_intent: 'pi_1', object: 'charge' }]]));
assert.strictEqual(stripe.providerCustomerId, 'cus_1');
assert.strictEqual(stripe.grossAmountMinor, 1000);
assert.strictEqual(stripe.feeAmountMinor, 59);
assert.strictEqual(stripe.netAmountMinor, 941);

const paypal = history.normalizePayPal({ transaction_info: { transaction_id: 'PP-1', transaction_event_code: 'T0006', transaction_initiation_date: '2026-01-01T12:00:00Z', transaction_amount: { currency_code: 'GBP', value: '10.00' }, fee_amount: { currency_code: 'GBP', value: '-0.59' } }, payer_info: { account_id: 'PAYER-1' } });
assert.strictEqual(paypal.providerCustomerId, 'PAYER-1');
assert.strictEqual(paypal.grossAmountMinor, 1000);
assert.strictEqual(paypal.feeAmountMinor, 59, 'PayPal negative fee should normalize to a positive processor cost');
assert.strictEqual(paypal.netAmountMinor, 941);

const jpy = history.normalizePayPal({ transaction_info: { transaction_id: 'PP-JPY', transaction_initiation_date: '2026-01-02T12:00:00Z', transaction_amount: { currency_code: 'JPY', value: '1000' }, fee_amount: { currency_code: 'JPY', value: '-50' } } });
assert.strictEqual(jpy.grossAmountMinor, 1000, 'zero-decimal currencies must not be multiplied by 100');
assert.strictEqual(jpy.feeAmountMinor, 50);

const deduped = history.dedupeTransactions([stripe, stripe, paypal]);
assert.strictEqual(deduped.length, 2, 'provider transaction IDs must be idempotent within a fetch');
const summary = history.summarize(deduped, new Set(['stripe:txn_1']));
assert.strictEqual(summary.total, 2);
assert.strictEqual(summary.existingCount, 1);
assert.strictEqual(summary.newCount, 1);

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'history-import.js'), 'utf8');
assert.ok(!source.includes("require('./lifecycle')"), 'historical imports must stay outside lifecycle/entitlement code');
assert.ok(!/activatePurchase|updateProviderSubscription|grantAccess/.test(source), 'historical imports must never activate or update access');

const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '042_payment_history_import.sql'), 'utf8');
assert.ok(/UNIQUE\(provider, provider_transaction_id\)/.test(migration), 'historical ledger must enforce provider-level transaction dedupe');
assert.ok(/Historical provider accounting ledger only/.test(migration), 'migration must document the non-entitlement boundary');

const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-payment-history.js'), 'utf8');
assert.ok(adminSource.includes('csrf.verify(req)'), 'history mutations must be CSRF protected');
assert.ok(adminSource.includes("req.body?.confirm !== '1'"), 'committed imports must require explicit operator confirmation');

console.log('Payment history import smoke passed.');
