'use strict';

const { query } = require('../db');

// PayPal Transaction Search classifies Express Checkout / one-time checkout
// receipts as customer payments. Live capture webhooks do not expose a
// transaction_event_code, so use the canonical payment code until a later
// historical import enriches the same provider transaction row.
const LIVE_CAPTURE_PAYMENT_TYPE = 'T0006';

function moneyMinor(value) {
    const amount = Number(value?.value);
    return Number.isFinite(amount) ? Math.round(amount * 100) : null;
}

function relatedIds(capture) {
    return capture?.supplementary_data?.related_ids || capture?.related_ids || {};
}

function historyValues(capture, customerId = null) {
    if (!capture?.id || String(capture.status || '').toUpperCase() !== 'COMPLETED') return null;

    const grossMinor = moneyMinor(capture.amount);
    const feeMinor = moneyMinor(capture?.seller_receivable_breakdown?.paypal_fee);
    const netMinor = moneyMinor(capture?.seller_receivable_breakdown?.net_amount);
    const currency = String(
        capture?.amount?.currency_code ||
        capture?.seller_receivable_breakdown?.gross_amount?.currency_code ||
        ''
    ).toUpperCase();

    // Financial reporting must never guess PayPal fees/net proceeds. A webhook
    // missing the authoritative breakdown is retried instead of booking a
    // misleading zero-fee payment.
    if (!currency || grossMinor == null || grossMinor <= 0 || feeMinor == null || netMinor == null) return null;

    const ids = relatedIds(capture);
    return {
        providerTransactionId: String(capture.id),
        status: 'S',
        occurredAt: capture.create_time || capture.update_time || new Date(),
        currency,
        grossMinor,
        feeMinor,
        netMinor,
        providerCustomerId: capture?.payer?.payer_id || null,
        providerReferenceId: ids.order_id || null,
        providerSourceId: ids.authorization_id || null,
        customerId: customerId || null,
        metadata: {
            livePaypalWebhook: true,
            providerAuthoritative: true,
            feeDataAvailable: true,
            providerCaptureStatus: String(capture.status || '').toUpperCase(),
            orderId: ids.order_id || null
        }
    };
}

async function resolveCustomerId(capture) {
    if (!capture?.id) return null;
    const mapped = await query(`
        SELECT customer_id
          FROM subscriptions
         WHERE source='paypal' AND provider_subscription_id=$1
         ORDER BY created_at DESC
         LIMIT 2
    `, [String(capture.id)]);
    const ids = [...new Set(mapped.rows.map(row => String(row.customer_id || '')).filter(Boolean))];
    return ids.length === 1 ? ids[0] : null;
}

async function upsertCapture(capture, { eventId = null } = {}) {
    const customerId = await resolveCustomerId(capture);
    const values = historyValues(capture, customerId);
    if (!values) {
        throw new Error(`PayPal completed capture ${capture?.id || '(missing id)'} is missing authoritative amount/fee/net data.`);
    }

    const metadata = { ...values.metadata, providerEventId: eventId || null };
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,
            provider_reference_id,provider_source_id,customer_id,metadata
        ) VALUES(
            'paypal',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb
        )
        ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
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
            metadata=payment_history_transactions.metadata || EXCLUDED.metadata,
            updated_at=NOW()
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

    return { recorded: true, id: values.providerTransactionId, customerId: values.customerId };
}

async function recordVerifiedWebhook(rawBody) {
    const event = JSON.parse(Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody));
    if (event?.event_type !== 'PAYMENT.CAPTURE.COMPLETED') return { recorded: false, skipped: true };
    return upsertCapture(event.resource || {}, { eventId: event.id || null });
}

module.exports = {
    LIVE_CAPTURE_PAYMENT_TYPE,
    moneyMinor,
    relatedIds,
    historyValues,
    resolveCustomerId,
    upsertCapture,
    recordVerifiedWebhook
};
