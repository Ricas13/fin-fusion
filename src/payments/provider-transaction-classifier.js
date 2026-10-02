'use strict';

// Canonical provider-ledger classification. Every accounting surface must use
// this module so the same provider transaction can never be revenue in one
// screen and ignored/refunded in another. Transactions/export consumers reach
// this contract through history-accounting, keeping every reporting surface aligned.
const STRIPE_PAYMENT_CATEGORIES = new Set(['charge']);
const STRIPE_REFUND_CATEGORIES = new Set(['refund', 'partial_capture_reversal']);
const PAYPAL_PAYMENT_CODES = new Set([
    'T0000','T0002','T0003','T0004','T0005','T0006','T0007','T0009','T0010',
    'T0011','T0012','T0013','T0018','T0019','T0021','T0022','T0023'
]);
const PAYPAL_REFUND_CODES = new Set(['T1106','T1107','T1120','T1201']);
const PAYPAL_SUCCESS_STATUS = 'S';
const PAYPAL_LIVE_PAYMENT_TYPES = new Set(['paypal_sale','paypal_subscription_payment']);
const PAYPAL_LIVE_REFUND_TYPES = new Set(['paypal_refund','paypal_reversal']);
const PLISIO_PAYMENT_TYPES = new Set(['payment']);
const PLISIO_REFUND_TYPES = new Set(['refund']);

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
        const code = clean(type);
        const upperCode = code.toUpperCase();
        const upperStatus = clean(status).toUpperCase();
        // Transaction Search rows retain PayPal's event-code contract and must
        // be successful (S). Authenticated live webhook rows use explicit
        // semantic types so customer history can converge before a reporting
        // import catches up, without pretending they carry exact fee data.
        if (PAYPAL_PAYMENT_CODES.has(upperCode) || PAYPAL_REFUND_CODES.has(upperCode)) {
            if (upperStatus !== PAYPAL_SUCCESS_STATUS) return null;
            if (amount > 0 && PAYPAL_PAYMENT_CODES.has(upperCode)) return 'payment';
            if (amount < 0 && PAYPAL_REFUND_CODES.has(upperCode)) return 'refund';
            return null;
        }
        const lowerCode=code.toLowerCase();
        if (!['COMPLETED','SUCCEEDED','SUCCESS'].includes(upperStatus)) return null;
        if (amount > 0 && PAYPAL_LIVE_PAYMENT_TYPES.has(lowerCode)) return 'payment';
        if (amount < 0 && PAYPAL_LIVE_REFUND_TYPES.has(lowerCode)) return 'refund';
        return null;
    }

    if (source === 'plisio') {
        const statusValue = clean(status).toLowerCase();
        if (!['completed','success','succeeded'].includes(statusValue)) return null;
        if (amount > 0 && PLISIO_PAYMENT_TYPES.has(transactionType)) return 'payment';
        if (amount < 0 && PLISIO_REFUND_TYPES.has(transactionType)) return 'refund';
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
    PAYPAL_LIVE_PAYMENT_TYPES,
    PAYPAL_LIVE_REFUND_TYPES,
    PLISIO_PAYMENT_TYPES,
    PLISIO_REFUND_TYPES,
    classifyProviderTransaction,
    historyKind
};
