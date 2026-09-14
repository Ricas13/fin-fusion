'use strict';

const { query } = require('../db');

// PayPal Transaction Search classifies Express Checkout / one-time checkout
// receipts as customer payments. Live captures use the same canonical type.
const LIVE_CAPTURE_PAYMENT_TYPE = 'T0006';
const ZERO_DECIMAL_CURRENCIES = new Set(['HUF', 'JPY', 'TWD']);

function currencyExponent(currency) {
    return ZERO_DECIMAL_CURRENCIES.has(String(currency || '').toUpperCase()) ? 0 : 2;
}

function moneyMinor(value) {
    const amount = Number(value?.value);
    const currency = String(value?.currency_code || value?.currency || '').toUpperCase();
    if (!Number.isFinite(amount) || !currency) return null;
    return Math.round(amount * (10 ** currencyExponent(currency)));
}

function moneyCurrency(value) {
    return String(value?.currency_code || value?.currency || '').toUpperCase() || null;
}

function relatedIds(capture) {
    return capture?.supplementary_data?.related_ids || capture?.related_ids || {};
}

function authoritativeTimestamp(capture) {
    return capture?.create_time || capture?.update_time || null;
}

function validFinancialTriplet(grossMinor, feeMinor, netMinor) {
    return Number.isInteger(grossMinor) && grossMinor > 0
        && Number.isInteger(feeMinor) && feeMinor >= 0 && feeMinor <= grossMinor
        && Number.isInteger(netMinor) && netMinor >= 0
        && grossMinor - feeMinor === netMinor;
}

function hasAuthoritativeFinancials(capture) {
    if (!capture?.id || String(capture.status || '').toUpperCase() !== 'COMPLETED') return false;
    const gross = capture.amount || capture?.seller_receivable_breakdown?.gross_amount;
    const fee = capture?.seller_receivable_breakdown?.paypal_fee;
    const net = capture?.seller_receivable_breakdown?.net_amount;
    const currencies = [moneyCurrency(gross), moneyCurrency(fee), moneyCurrency(net)];
    const grossMinor = moneyMinor(gross), feeMinor = moneyMinor(fee), netMinor = moneyMinor(net);
    return Boolean(
        authoritativeTimestamp(capture) &&
        currencies.every(Boolean) &&
        new Set(currencies).size === 1 &&
        validFinancialTriplet(grossMinor, feeMinor, netMinor)
    );
}

function historyValues(capture, { customerId = null, providerCustomerId = null } = {}) {
    if (!capture?.id || String(capture.status || '').toUpperCase() !== 'COMPLETED') return null;

    const gross = capture.amount || capture?.seller_receivable_breakdown?.gross_amount;
    const fee = capture?.seller_receivable_breakdown?.paypal_fee;
    const net = capture?.seller_receivable_breakdown?.net_amount;
    const grossMinor = moneyMinor(gross);
    const feeMinor = moneyMinor(fee);
    const netMinor = moneyMinor(net);
    const currencies = [moneyCurrency(gross), moneyCurrency(fee), moneyCurrency(net)];
    const occurredAt = authoritativeTimestamp(capture);

    if (!occurredAt || currencies.some(value => !value) || new Set(currencies).size !== 1) return null;
    if (!validFinancialTriplet(grossMinor, feeMinor, netMinor)) return null;

    const ids = relatedIds(capture);
    return {
        providerTransactionId: String(capture.id),
        status: 'S',
        occurredAt,
        currency: currencies[0],
        grossMinor,
        feeMinor,
        netMinor,
        providerCustomerId: providerCustomerId || capture?.payer?.payer_id || null,
        providerReferenceId: ids.order_id || null,
        providerSourceId: ids.authorization_id || null,
        customerId: customerId || null,
        metadata: {
            livePaypal: true,
            providerAuthoritative: true,
            feeDataAvailable: true,
            providerCaptureStatus: String(capture.status || '').toUpperCase(),
            orderId: ids.order_id || null
        }
    };
}

async function upsertValues(values, { eventId = null, reconciliation = false } = {}) {
    const metadata = {
        ...values.metadata,
        ...(eventId ? { providerEventId: String(eventId) } : {}),
        ...(reconciliation ? { reconciled: true } : {})
    };
    const result = await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,
            provider_reference_id,provider_source_id,customer_id,metadata
        ) VALUES(
            'paypal',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
        )
        ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
            transaction_type=COALESCE(payment_history_transactions.transaction_type,EXCLUDED.transaction_type),
            transaction_status=EXCLUDED.transaction_status,
            occurred_at=EXCLUDED.occurred_at,
            currency=EXCLUDED.currency,
            gross_amount_minor=EXCLUDED.gross_amount_minor,
            fee_amount_minor=EXCLUDED.fee_amount_minor,
            net_amount_minor=EXCLUDED.net_amount_minor,
            provider_customer_id=COALESCE(EXCLUDED.provider_customer_id,payment_history_transactions.provider_customer_id),
            provider_reference_id=COALESCE(EXCLUDED.provider_reference_id,payment_history_transactions.provider_reference_id),
            provider_source_id=COALESCE(EXCLUDED.provider_source_id,payment_history_transactions.provider_source_id),
            customer_id=COALESCE(payment_history_transactions.customer_id,EXCLUDED.customer_id),
            metadata=COALESCE(payment_history_transactions.metadata,'{}'::jsonb) || COALESCE(EXCLUDED.metadata,'{}'::jsonb),
            updated_at=NOW()
        WHERE payment_history_transactions.customer_id IS NULL
           OR EXCLUDED.customer_id IS NULL
           OR payment_history_transactions.customer_id=EXCLUDED.customer_id
        RETURNING customer_id
    `, [
        values.providerTransactionId,
        LIVE_CAPTURE_PAYMENT_TYPE,
        values.status,
        values.occurredAt,
        values.currency,
        values.grossMinor,
        values.feeMinor,
        values.netMinor,
        values.providerCustomerId,
        values.providerReferenceId,
        values.providerSourceId,
        values.customerId,
        JSON.stringify(metadata)
    ]);
    if (result.rowCount !== 1) {
        throw new Error(`PayPal capture ${values.providerTransactionId} conflicts with an existing financial-history customer owner.`);
    }
    return { recorded: true, id: values.providerTransactionId, customerId: result.rows[0]?.customer_id || values.customerId };
}

async function recordCapture(capture, {
    customerId = null,
    providerCustomerId = null,
    eventId = null,
    fetchCapture = null,
    reconciliation = false
} = {}) {
    if (!capture?.id) throw new Error('PayPal completed capture is missing its capture ID.');
    let authoritative = capture;
    if (!hasAuthoritativeFinancials(authoritative)) {
        if (typeof fetchCapture !== 'function') {
            throw new Error(`PayPal completed capture ${capture.id} is missing authoritative amount/fee/net/timestamp data.`);
        }
        authoritative = await fetchCapture(String(capture.id));
    }
    const values = historyValues(authoritative, { customerId, providerCustomerId });
    if (!values) {
        throw new Error(`PayPal completed capture ${capture.id} could not be normalized from authoritative provider data.`);
    }
    return upsertValues(values, { eventId, reconciliation });
}

module.exports = {
    LIVE_CAPTURE_PAYMENT_TYPE,
    ZERO_DECIMAL_CURRENCIES,
    currencyExponent,
    moneyMinor,
    moneyCurrency,
    relatedIds,
    authoritativeTimestamp,
    validFinancialTriplet,
    hasAuthoritativeFinancials,
    historyValues,
    upsertValues,
    recordCapture
};
