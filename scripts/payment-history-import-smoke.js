'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const historyAccounting = require('../src/payments/history-accounting');
const dashboardLedger = require('../src/payments/dashboard-ledger');
const classifier = require('../src/payments/provider-transaction-classifier');

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

// All accounting consumers must share one exact classifier contract.
assert.strictEqual(dashboardLedger.historyKind, classifier.historyKind);
assert.strictEqual(historyAccounting.historyKind, classifier.historyKind);
assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'stripe', type: 'charge', grossMinor: 1000 }), 'payment');
assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'stripe', type: 'refund', grossMinor: -500 }), 'refund');
assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'stripe', type: 'partial_capture_reversal', grossMinor: -500 }), 'refund');
assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'stripe', type: 'payout', grossMinor: -941 }), null, 'Stripe payouts must never be counted as customer revenue');
for (const code of ['T0004','T0009','T0010','T0013','T0021']) assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'paypal', type: code, status: 'S', grossMinor: 1000 }), 'payment', `${code} must use the canonical PayPal payment list`);
for (const code of ['T1106','T1201']) assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'paypal', type: code, status: 'S', grossMinor: -500 }), 'refund', `${code} must use the canonical PayPal refund list`);
assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'paypal', type: 'T0006', status: 'S', grossMinor: 1000 }), 'payment');
for (const status of ['', 'P', 'D', 'V']) assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'paypal', type: 'T0006', status, grossMinor: 1000 }), null, `PayPal status ${status || '(blank)'} must not be booked as completed revenue`);
assert.strictEqual(classifier.classifyProviderTransaction({ provider: 'paypal', type: 'T0400', status: 'S', grossMinor: -941 }), null, 'PayPal withdrawals must never be counted as customer revenue');

assert.strictEqual(historyAccounting.historyKind({ provider: 'stripe', transaction_type: 'charge', transaction_status: 'available', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(historyAccounting.historyKind({ provider: 'paypal', transaction_type: 'T0006', transaction_status: 'S', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(historyAccounting.historyKind({ provider: 'paypal', transaction_type: 'T0006', transaction_status: 'P', gross_amount_minor: 1000 }), null, 'pending PayPal rows must not be booked as revenue');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'paypal', transaction_type: 'T0006', transaction_status: 'S', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(dashboardLedger.historyKind({ provider: 'paypal', transaction_type: 'T0006', transaction_status: 'D', gross_amount_minor: 1000 }), null, 'dashboard must reject denied PayPal revenue too');

// Stripe charge.refunded amount_refunded is cumulative. The second webhook
// below means another 20.00 was refunded, not another 30.00.
const refundState = new Map(), refundWarnings = [];
const refund1 = dashboardLedger.refundFromEvent({ provider: 'stripe', event_type: 'charge.refunded', payload: { data: { object: { id: 'ch_partial', amount_refunded: 1000, currency: 'usd' }, previous_attributes: { amount_refunded: 0 } } } }, refundState, refundWarnings);
const refund2 = dashboardLedger.refundFromEvent({ provider: 'stripe', event_type: 'charge.refunded', payload: { data: { object: { id: 'ch_partial', amount_refunded: 3000, currency: 'usd' }, previous_attributes: { amount_refunded: 1000 } } } }, refundState, refundWarnings);
assert.strictEqual(refund1.minor, 1000);
assert.strictEqual(refund2.minor, 2000);
assert.strictEqual(refund1.minor + refund2.minor, 3000, 'partial-refund webhooks must never sum cumulative totals');
assert.deepStrictEqual(refundWarnings, []);
const fallbackRefund = dashboardLedger.refundFromEvent({ provider: 'stripe', event_type: 'charge.refunded', payload: { data: { object: { id: 'ch_fallback', amount_refunded: 3000, currency: 'usd', refunds: { data: [{ id: 're_2', amount: 2000, created: 2 }, { id: 're_1', amount: 1000, created: 1 }] } } } } }, new Map(), []);
assert.strictEqual(fallbackRefund.minor, 2000, 'when previous cumulative state is absent, use the refund object amount rather than charge.amount_refunded');
const unsafeWarnings = [];
assert.strictEqual(dashboardLedger.refundFromEvent({ provider: 'stripe', event_type: 'charge.refunded', payload: { data: { object: { id: 'ch_unknown', amount_refunded: 3000, currency: 'usd' } } } }, new Map(), unsafeWarnings), null, 'unsafe cumulative-only refunds must not be guessed');
assert(unsafeWarnings.some(message => /Payment History import/.test(message)), 'unsafe refund fallback must produce an admin-facing completeness warning');

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

const classifierSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'provider-transaction-classifier.js'), 'utf8');
const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'dashboard-ledger.js'), 'utf8');
const accountingSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'history-accounting.js'), 'utf8');
const reconciliationSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'provider-payment-reconciliation.js'), 'utf8');
assert.ok(dashboardSource.includes("require('./provider-transaction-classifier')"), 'Commerce ledger must import the canonical classifier');
assert.ok(accountingSource.includes("require('./provider-transaction-classifier')"), 'Payment History must import the canonical classifier');
assert.ok(reconciliationSource.includes("require('./provider-transaction-classifier')"), 'provider reconciliation must import the canonical classifier');
assert.ok(!/const PAYPAL_(?:PAYMENT|REFUND)_CODES/.test(dashboardSource), 'Commerce must not define a second PayPal code list');
assert.ok(!/const PAYPAL_(?:PAYMENT|REFUND)_CODES/.test(accountingSource), 'Payment History must not define a second PayPal code list');
assert.ok(/T0004[\s\S]*T0021/.test(classifierSource) && /T1106[\s\S]*T1201/.test(classifierSource), 'canonical classifier must retain the complete PayPal accounting code lists');
assert.ok(/partial_capture_reversal/.test(classifierSource), 'canonical Stripe refunds must include partial capture reversals');
assert.ok(dashboardSource.includes('transaction_status'), 'Commerce imported-history query must include provider transaction status');
assert.ok(dashboardSource.includes('paymentEventsInRange(range)'), 'Commerce webhook fallback must use the paginated reader');
assert.ok(dashboardSource.includes('EVENT_PAGE_SIZE') && dashboardSource.includes('cursor?.created_at'), 'webhook fallback must keyset paginate provider events');
assert.ok(!dashboardSource.includes('LIMIT 25000'), 'Commerce financial totals must never silently stop at 25,000 payment events');
assert.ok(dashboardSource.includes("status='completed'"), 'dashboard accounting may only trust completed import coverage');
assert.ok(dashboardSource.includes('completed_at'), 'dashboard accounting must cap same-day coverage at the actual import completion time');

const flexibleCheckoutSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'flexible-checkout.js'), 'utf8');
const discountsSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'discounts.js'), 'utf8');
assert.ok(flexibleCheckoutSource.includes('checkoutTtlMinutes=intents.providerMaxTtl(provider)'), 'checkout must derive one provider TTL for intent and reservation');
assert.ok((flexibleCheckoutSource.match(/ttlMinutes:checkoutTtlMinutes/g) || []).length >= 2, 'discount reservation TTL must match the parent checkout TTL');
assert.ok(discountsSource.includes('SELECT id,customer_id,state,expires_at') && discountsSource.includes('FROM billing_checkout_intents WHERE id=$1 FOR SHARE'), 'reservation layer must verify its parent checkout expiry');
assert.ok(discountsSource.includes('Math.max(requestedExpiry.getTime(),parentExpiry.getTime())'), 'reservation may never expire before its parent checkout intent');

const dashboardPageSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-dashboard-page.js'), 'utf8');
const dashboardMoneySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-dashboard-money.js'), 'utf8');
const reportingSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'reporting-currency.js'), 'utf8');
assert.ok(dashboardPageSource.includes('financialWarningBanner(ctx)'), 'financial completeness warnings must be rendered above dashboard widgets');
assert.ok(dashboardPageSource.includes('Do not treat affected revenue/refund totals as complete'), 'admin warning must explicitly say affected totals are not complete');
assert.ok(dashboardMoneySource.includes('warnings:accounting.warnings||[]'), 'Main dashboard normalization must propagate ledger warnings');
assert.ok(reportingSource.includes('lastFinancialWarning'), 'FX fallback failures must be retained as an admin-visible financial warning');
assert.ok(reportingSource.includes('Dashboard currency conversions are using the last stored rates'), 'FX fallback must explain the degraded financial state');
assert.ok(reconciliationSource.includes('Financial/provider failures are deliberately returned to the UI'), 'reconciliation error fallback must remain explicitly UI-visible');

const migration = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '042_payment_history_import.sql'), 'utf8');
assert.ok(/UNIQUE\(provider, provider_transaction_id\)/.test(migration), 'historical ledger must enforce provider-level transaction dedupe');
assert.ok(/Historical provider accounting ledger only/.test(migration), 'migration must document the non-entitlement boundary');

console.log('Payment history import smoke passed.');
