'use strict';

const { query } = require('../db');
const classifier = require('./provider-transaction-classifier');

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

        const kind = classifier.historyKind(row);
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
    historyKind: classifier.historyKind,
    summarizeRows,
    storedRevenueSummary,
    PAYPAL_PAYMENT_CODES: classifier.PAYPAL_PAYMENT_CODES,
    PAYPAL_REFUND_CODES: classifier.PAYPAL_REFUND_CODES,
    STRIPE_PAYMENT_CATEGORIES: classifier.STRIPE_PAYMENT_CATEGORIES,
    STRIPE_REFUND_CATEGORIES: classifier.STRIPE_REFUND_CATEGORIES
};
