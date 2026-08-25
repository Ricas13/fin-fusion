'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const history = require('../src/payments/history-import');
const historyAccounting = require('../src/payments/history-accounting');
const dashboardLedger = require('../src/payments/dashboard-ledger');
const paymentHistoryAdmin = require('../src/platform/admin-payment-history');

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

const paypal = history.normalizePayPal({ transaction_info: { transaction_id: 'PP-1', transaction_event_code: 'T0006', transaction_status: 'S', transaction_initiation_date: '2026-01-01T12:00:00Z', transaction_amount: { currency_code: 'GBP', value: '10.00' }, fee_amount: { currency_code: 'GBP', value: '-0.59' } }, payer_info: { account_id: 'PAYER-1' } });
assert.strictEqual(paypal.providerCustomerId, 'PAYER-1');
assert.strictEqual(paypal.grossAmountMinor, 1000);
assert.strictEqual(paypal.feeAmountMinor, 59, 'PayPal negative fee should normalize to a positive processor cost');
assert.strictEqual(paypal.netAmountMinor, 941);
assert.strictEqual(paypal.metadata.rawFeeAmountMinor, -59, 'PayPal provider fee sign should be retained for accounting auditability');

const jpy = history.normalizePayPal({ transaction_info: { transaction_id: 'PP-JPY', transaction_status: 'S', transaction_initiation_date: '2026-01-02T12:00:00Z', transaction_amount: { currency_code: 'JPY', value: '1000' }, fee_amount: { currency_code: 'JPY', value: '-50' } } });
assert.strictEqual(jpy.grossAmountMinor, 1000, 'zero-decimal currencies must not be multiplied by 100');
assert.strictEqual(jpy.feeAmountMinor, 50);

const deduped = history.dedupeTransactions([stripe, stripe, paypal]);
assert.strictEqual(deduped.length, 2, 'provider transaction IDs must be idempotent within a fetch');
const summary = history.summarize(deduped, new Set(['stripe:txn_1']));
assert.strictEqual(summary.total, 2);
assert.strictEqual(summary.existingCount, 1);
assert.strictEqual(summary.newCount, 1);

const coverage = dashboardLedger.coverageFromRuns([
    { provider_scope: 'stripe', range_start: '2025-01-01', range_end: '2025-01-31' },
    { provider_scope: 'stripe', range_start: '2025-02-01', range_end: '2025-02-28' },
    { provider_scope: 'both', range_start: '2026-01-01', range_end: '2026-01-31' }
]);
assert.strictEqual(coverage.stripe.length, 2, 'adjacent Stripe import runs should merge into one 2025 interval plus the 2026 interval');
assert.strictEqual(coverage.paypal.length, 1, 'both-provider runs must create PayPal coverage');
assert(dashboardLedger.isCovered(coverage, 'stripe', '2025-02-15T12:00:00Z'));
assert(!dashboardLedger.isCovered(coverage, 'paypal', '2025-02-15T12:00:00Z'));

const sameDayCoverage = dashboardLedger.coverageFromRuns([
    { provider_scope: 'stripe', range_start: '2026-08-25', range_end: '2026-08-25', completed_at: '2026-08-25T12:00:00.000Z' }
]);
assert(dashboardLedger.isCovered(sameDayCoverage, 'stripe', '2026-08-25T11:59:59.000Z'), 'same-day imported rows before completion must be authoritative');
assert(!dashboardLedger.isCovered(sameDayCoverage, 'stripe', '2026-08-25T12:00:01.000Z'), 'live payments after a same-day import completes must remain visible');

assert.strictEqual(dashboardLedger.historyKind({ provider: 'stripe', transaction_type: 'charge', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'stripe', transaction_type: 'refund', gross_amount_minor: -500 }), 'refund');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'stripe', transaction_type: 'payout', gross_amount_minor: -941 }), null, 'Stripe payouts must never be counted as customer revenue');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'paypal', transaction_type: 'T0006', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'paypal', transaction_type: 'T0002', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'paypal', transaction_type: 'T1107', gross_amount_minor: -500 }), 'refund');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'paypal', transaction_type: 'T0400', gross_amount_minor: -941 }), null, 'PayPal withdrawals must never be counted as customer revenue');

assert.strictEqual(historyAccounting.historyKind({ provider: 'stripe', transaction_type: 'charge', transaction_status: 'available', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(historyAccounting.historyKind({ provider: 'stripe', transaction_type: 'payout', gross_amount_minor: -941 }), null, 'raw Stripe payouts are audit records, not revenue');
assert.strictEqual(historyAccounting.historyKind({ provider: 'paypal', transaction_type: 'T0006', transaction_status: 'S', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(historyAccounting.historyKind({ provider: 'paypal', transaction_type: 'T0006', transaction_status: 'P', gross_amount_minor: 1000 }), null, 'pending PayPal rows must not be booked as revenue');
assert.strictEqual(historyAccounting.historyKind({ provider: 'paypal', transaction_type: 'T0400', transaction_status: 'S', gross_amount_minor: -941 }), null, 'PayPal withdrawals are not customer revenue');

const revenueRows = historyAccounting.summarizeRows([
    { provider: 'stripe', transaction_type: 'charge', transaction_status: 'available', currency: 'GBP', gross_amount_minor: 1000, fee_amount_minor: 59, occurred_at: '2026-08-01T12:00:00Z' },
    { provider: 'stripe', transaction_type: 'refund', transaction_status: 'available', currency: 'GBP', gross_amount_minor: -200, fee_amount_minor: 0, occurred_at: '2026-08-02T12:00:00Z' },
    { provider: 'stripe', transaction_type: 'payout', transaction_status: 'available', currency: 'GBP', gross_amount_minor: -741, fee_amount_minor: 0, occurred_at: '2026-08-03T12:00:00Z' }
]);
assert.strictEqual(revenueRows.length, 1);
assert.strictEqual(revenueRows[0].raw_transactions, 3);
assert.strictEqual(revenueRows[0].payment_transactions, 1);
assert.strictEqual(revenueRows[0].refund_transactions, 1);
assert.strictEqual(revenueRows[0].ignored_transactions, 1);
assert.strictEqual(revenueRows[0].gross_sales_minor, 1000);
assert.strictEqual(revenueRows[0].refund_amount_minor, 200);
assert.strictEqual(revenueRows[0].payment_fees_minor, 59);
assert.strictEqual(revenueRows[0].net_proceeds_minor, 741, 'payout movement must not collapse real sales/net proceeds');

const usdReporting = { currency: 'USD', rates: { GBP: 1, USD: 1.25, EUR: 1.1 }, source: 'test' };
const normalizedUsd = paymentHistoryAdmin.normalizeRevenueRows([
    { provider: 'paypal', currency: 'GBP', raw_transactions: 3, payment_transactions: 2, refund_transactions: 0, ignored_transactions: 1, gross_sales_minor: 1000, refund_amount_minor: 0, payment_fees_minor: 50, first_at: '2026-01-01', last_at: '2026-01-03' },
    { provider: 'paypal', currency: 'EUR', raw_transactions: 2, payment_transactions: 1, refund_transactions: 1, ignored_transactions: 0, gross_sales_minor: 1100, refund_amount_minor: 220, payment_fees_minor: 55, first_at: '2026-01-04', last_at: '2026-01-05' },
    { provider: 'paypal', currency: 'USD', raw_transactions: 1, payment_transactions: 1, refund_transactions: 0, ignored_transactions: 0, gross_sales_minor: 1000, refund_amount_minor: 0, payment_fees_minor: 25, first_at: '2026-01-06', last_at: '2026-01-06' }
], usdReporting);
assert.strictEqual(normalizedUsd.length, 1, 'all supported source currencies for one provider should collapse to one reporting-currency row');
assert.strictEqual(normalizedUsd[0].currency, 'USD');
assert.deepStrictEqual(normalizedUsd[0].source_currencies, ['EUR', 'GBP', 'USD']);
assert.strictEqual(normalizedUsd[0].raw_transactions, 6);
assert.strictEqual(normalizedUsd[0].payment_transactions, 4);
assert.strictEqual(normalizedUsd[0].gross_sales_minor, 3500, 'GBP/EUR/USD gross sales should normalize into the configured USD reporting currency');
assert.strictEqual(normalizedUsd[0].refund_amount_minor, 250);
assert.strictEqual(normalizedUsd[0].payment_fees_minor, 150);
assert.strictEqual(normalizedUsd[0].net_proceeds_minor, 3100);

const normalizedPreview = paymentHistoryAdmin.normalizePreviewTotals({ byCurrency: {
    GBP: { transactions: 2, grossAmountMinor: 1000, feeAmountMinor: 50, netAmountMinor: 950 },
    EUR: { transactions: 1, grossAmountMinor: 1100, feeAmountMinor: 55, netAmountMinor: 1045 },
    USD: { transactions: 1, grossAmountMinor: 1000, feeAmountMinor: 25, netAmountMinor: 975 }
} }, usdReporting);
assert.strictEqual(normalizedPreview.currency, 'USD');
assert.strictEqual(normalizedPreview.transactions, 4);
assert.strictEqual(normalizedPreview.grossAmountMinor, 3500);
assert.strictEqual(normalizedPreview.feeAmountMinor, 150);
assert.strictEqual(normalizedPreview.netAmountMinor, 3350);
assert.deepStrictEqual(normalizedPreview.sourceCurrencies, ['EUR', 'GBP', 'USD']);

const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'history-import.js'), 'utf8');
assert.ok(!source.includes("require('./lifecycle')"), 'historical imports must stay outside lifecycle/entitlement code');
assert.ok(!/activatePurchase|updateProviderSubscription|grantAccess/.test(source), 'historical imports must never activate or update access');
assert.ok(source.includes("url.searchParams.set('balance_affecting_records_only', 'Y')"), 'PayPal imports must explicitly request only balance-impacting records');

const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'dashboard-ledger.js'), 'utf8');
assert.ok(dashboardSource.includes("status='completed'"), 'dashboard accounting may only trust completed import coverage');
assert.ok(dashboardSource.includes('completed_at'), 'dashboard accounting must cap same-day coverage at the actual import completion time');
assert.ok(dashboardSource.includes("if (isCovered(coverage, row.provider, row.created_at)) continue"), 'covered provider/date windows must suppress duplicate live webhook accounting');
assert.ok(/STRIPE_PAYMENT_CATEGORIES[\s\S]*charge/.test(dashboardSource), 'dashboard history must classify Stripe charges as customer revenue');
assert.ok(/PAYPAL_PAYMENT_CODES[\s\S]*T0006/.test(dashboardSource), 'dashboard history must classify PayPal checkout receipts as customer revenue');

const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '042_payment_history_import.sql'), 'utf8');
assert.ok(/UNIQUE\(provider, provider_transaction_id\)/.test(migration), 'historical ledger must enforce provider-level transaction dedupe');
assert.ok(/Historical provider accounting ledger only/.test(migration), 'migration must document the non-entitlement boundary');

const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-payment-history.js'), 'utf8');
assert.ok(adminSource.includes('csrf.verify(req)'), 'history mutations must be CSRF protected');
assert.ok(adminSource.includes("req.body?.confirm !== '1'"), 'committed imports must require explicit operator confirmation');
assert.ok(adminSource.includes("endDate: today"), 'the initial current-year import should end today rather than requesting future provider history');
assert.ok(adminSource.includes("assertHistoricalRange(values)"), 'payment history endpoints must reject future end dates server-side');
assert.ok(adminSource.includes('Future dates are not accepted.'), 'the admin form must explain the historical-only range constraint');
assert.ok(adminSource.includes('Imported revenue summary'), 'the history page must present customer revenue rather than raw provider balance totals as the primary ledger summary');
assert.ok(adminSource.includes('Raw provider movement preview'), 'raw balance movements must be explicitly labeled as non-revenue reconciliation data');
assert.ok(adminSource.includes('reportingCurrency.refreshRates()'), 'payment history must use the same refreshed reporting-currency state as the dashboards');
assert.ok(adminSource.includes('visible business totals are normalized'), 'the history page must explain that raw source currency is preserved while visible totals are normalized');

console.log('Payment history import smoke passed.');
