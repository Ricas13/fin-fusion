'use strict';

const { query } = require('../db');

// Stripe recommends reporting_category for accounting classification. The
// importer stores reporting_category in transaction_type when available.
const STRIPE_PAYMENT_CATEGORIES = new Set(['charge']);
const STRIPE_REFUND_CATEGORIES = new Set(['refund', 'partial_capture_reversal']);

// PayPal T00xx includes both customer payments and non-sales movements such as
// Mass Payments, postage, rebates and payouts. Keep only merchant/customer
// payment channels here; everything else remains in the raw audit ledger.
const PAYPAL_PAYMENT_CODES = new Set([
    'T0000', 'T0002', 'T0003', 'T0004', 'T0005', 'T0006', 'T0007',
    'T0009', 'T0010', 'T0011', 'T0012', 'T0013', 'T0018', 'T0019',
    'T0021', 'T0022', 'T0023'
]);
const PAYPAL_REFUND_CODES = new Set(['T1106', 'T1107', 'T1120', 'T1201']);

function historyKind(row) {
    const provider = String(row?.provider || '').toLowerCase();
    const type = String(row?.transaction_type || '').trim();
    const gross = Number(row?.gross_amount_minor || 0);

    if (provider === 'stripe') {
        const category = type.toLowerCase();
        if (gross > 0 && STRIPE_PAYMENT_CATEGORIES.has(category)) return 'payment';
        if (gross < 0 && STRIPE_REFUND_CATEGORIES.has(category)) return 'refund';
        return null;
    }

    if (provider === 'paypal') {
        // Transaction Search status S means successfully completed. Pending,
        // denied and already-reversed payment rows are not booked as revenue.
        const status = String(row?.transaction_status || '').toUpperCase();
        if (status && status !== 'S') return null;
        const code = type.toUpperCase();
        if (gross > 0 && PAYPAL_PAYMENT_CODES.has(code)) return 'payment';
        if (gross < 0 && PAYPAL_REFUND_CODES.has(code)) return 'refund';
    }
    return null;
}

function summarizeRows(rows) {
    const groups = new Map();
    for (const row of rows || []) {
        const provider = String(row.provider || '').toLowerCase();
        const currency = String(row.currency || 'UNKNOWN').toUpperCase();
        const key = `${provider}:${currency}`;
        const current = groups.get(key) || {
            provider,
            currency,
            raw_transactions: 0,
            payment_transactions: 0,
            refund_transactions: 0,
            ignored_transactions: 0,
            gross_sales_minor: 0,
            refund_amount_minor: 0,
            payment_fees_minor: 0,
            net_proceeds_minor: 0,
            first_at: null,
            last_at: null
        };
        current.raw_transactions += 1;
        const at = row.occurred_at ? new Date(row.occurred_at) : null;
        if (at && !Number.isNaN(at.getTime())) {
            if (!current.first_at || at < current.first_at) current.first_at = at;
            if (!current.last_at || at > current.last_at) current.last_at = at;
        }

        const kind = historyKind(row);
        if (kind === 'payment') {
            const gross = Math.max(0, Number(row.gross_amount_minor || 0));
            const fee = Math.max(0, Number(row.fee_amount_minor || 0));
            current.payment_transactions += 1;
            current.gross_sales_minor += gross;
            current.payment_fees_minor += fee;
        } else if (kind === 'refund') {
            current.refund_transactions += 1;
            current.refund_amount_minor += Math.abs(Number(row.gross_amount_minor || 0));
        } else {
            current.ignored_transactions += 1;
        }
        groups.set(key, current);
    }

    const output = Array.from(groups.values());
    for (const row of output) {
        row.net_proceeds_minor = row.gross_sales_minor - row.refund_amount_minor - row.payment_fees_minor;
    }
    return output.sort((a, b) => a.provider.localeCompare(b.provider) || a.currency.localeCompare(b.currency));
}

async function storedRevenueSummary() {
    const result = await query(`
        SELECT provider,transaction_type,transaction_status,currency,
               gross_amount_minor,fee_amount_minor,occurred_at
        FROM payment_history_transactions
        ORDER BY provider,currency,occurred_at
    `);
    return summarizeRows(result.rows);
}

module.exports = {
    historyKind,
    summarizeRows,
    storedRevenueSummary,
    PAYPAL_PAYMENT_CODES,
    PAYPAL_REFUND_CODES
};
