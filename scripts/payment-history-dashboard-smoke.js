'use strict';

const assert = require('assert');
const ledger = require('../src/payments/dashboard-ledger');

const coverage = ledger.coverageFromRuns([
    { provider_scope: 'stripe', range_start: '2025-01-01', range_end: '2025-01-31' },
    { provider_scope: 'stripe', range_start: '2025-02-01', range_end: '2025-02-28' },
    { provider_scope: 'both', range_start: '2026-01-01', range_end: '2026-01-31' }
]);
assert.strictEqual(coverage.stripe.length, 2, 'adjacent Stripe import runs should merge into one 2025 interval plus the 2026 interval');
assert.strictEqual(coverage.paypal.length, 1, 'both-provider runs must create PayPal coverage');
assert(ledger.isCovered(coverage, 'stripe', '2025-02-15T12:00:00Z'));
assert(!ledger.isCovered(coverage, 'paypal', '2025-02-15T12:00:00Z'));
assert(ledger.isCovered(coverage, 'paypal', '2026-01-15T12:00:00Z'));

assert.strictEqual(ledger.historyKind({ provider: 'stripe', transaction_type: 'charge', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(ledger.historyKind({ provider: 'stripe', transaction_type: 'refund', gross_amount_minor: -500 }), 'refund');
assert.strictEqual(ledger.historyKind({ provider: 'stripe', transaction_type: 'payout', gross_amount_minor: -941 }), null, 'Stripe payouts must never be counted as customer revenue');
assert.strictEqual(ledger.historyKind({ provider: 'paypal', transaction_type: 'T0006', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(ledger.historyKind({ provider: 'paypal', transaction_type: 'T0002', gross_amount_minor: 1000 }), 'payment');
assert.strictEqual(ledger.historyKind({ provider: 'paypal', transaction_type: 'T1107', gross_amount_minor: -500 }), 'refund');
assert.strictEqual(ledger.historyKind({ provider: 'paypal', transaction_type: 'T0400', gross_amount_minor: -941 }), null, 'PayPal withdrawals must never be counted as customer revenue');

console.log('Payment history dashboard smoke passed.');
