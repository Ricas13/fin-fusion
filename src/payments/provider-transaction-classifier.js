'use strict';

// Canonical provider-ledger classification. Every accounting surface must use
// this module so the same provider transaction can never be revenue in one
// screen and ignored/refunded in another.
const STRIPE_PAYMENT_CATEGORIES = new Set(['charge']);
const STRIPE_REFUND_CATEGORIES = new Set(['refund', 'partial_capture_reversal']);
const PAYPAL_PAYMENT_CODES = new Set([
    'T0000','T0002','T0003','T0004','T0005','T0006','T0007','T0009','T0010',
    'T0011','T0012','T0013','T0018','T0019','T0021','T0022','T0023'
]);
const PAYPAL_REFUND_CODES = new Set(['T1106','T1107','T1120','T1201']);
const PAYPAL_SUCCESS_STATUS = 'S';

function clean(value) { return String(value == null ? '' : value).trim(); }

function classifyProviderTransaction({ provider, type, status = '', grossMinor = 0 } = {}) {
    const source = clean(provider).toLowerCase();
    const transactionType = clean(type).toLowerCase();
    const amount = Number(grossMinor || 0);
    if (!Number.isFinite(amount) || amount === 0) return null;

    if (source === 'stripe') {
        if (amount > 0 && STRIPE_PAYMENT_CATEGORIES.has(transactionType)) return 'payment';
        if (amount < 0 && STRIPE_REFUND_CATEGORIES.has(transactionType)) return 'refund';
        return null;
    }

    if (source === 'paypal') {
        // Transaction Search status S is the only completed/successful ledger
        // state. Pending, denied, reversed and rows without an authoritative
        // success status must never be counted as realized revenue/refunds.
        if (clean(status).toUpperCase() !== PAYPAL_SUCCESS_STATUS) return null;
        const code = clean(type).toUpperCase();
        if (amount > 0 && PAYPAL_PAYMENT_CODES.has(code)) return 'payment';
        if (amount < 0 && PAYPAL_REFUND_CODES.has(code)) return 'refund';
    }
    return null;
}

function historyKind(row) {
    return classifyProviderTransaction({
        provider: row?.provider,
        type: row?.transaction_type,
        status: row?.transaction_status,
        grossMinor: row?.gross_amount_minor
    });
}

module.exports = {
    STRIPE_PAYMENT_CATEGORIES,
    STRIPE_REFUND_CATEGORIES,
    PAYPAL_PAYMENT_CODES,
    PAYPAL_REFUND_CODES,
    PAYPAL_SUCCESS_STATUS,
    classifyProviderTransaction,
    historyKind
};
