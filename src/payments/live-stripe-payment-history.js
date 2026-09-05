'use strict';

const Stripe = require('stripe');
const { query } = require('../db');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');

const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 30;
const MAX_PAGES = 100;
const MIN_SYNC_INTERVAL_MS = 60 * 1000;

let lastSyncAt = 0;
let inFlight = null;

function objectId(value) { return typeof value === 'string' ? value : value?.id || null; }
function positiveInteger(value) { const n = Number(value); return Number.isFinite(n) && n >= 0 ? Math.round(n) : null; }
function occurredAt(charge) { const created = Number(charge?.created); return Number.isFinite(created) && created > 0 ? new Date(created * 1000) : new Date(); }
function mergedMetadata(charge) {
    const paymentIntent = charge?.payment_intent && typeof charge.payment_intent === 'object' ? charge.payment_intent : null;
    return { ...(paymentIntent?.metadata || {}), ...(charge?.metadata || {}) };
}
function customerReference(charge) { return objectId(charge?.customer); }
function paymentIntentReference(charge) { return objectId(charge?.payment_intent); }
function invoiceReference(charge) { return objectId(charge?.invoice); }

async function resolveCustomerId(charge) {
    const metadata = mergedMetadata(charge);
    const claimed = String(metadata.internal_customer_id || '').trim();
    if (claimed) {
        const direct = await query('SELECT id FROM customers WHERE id=$1 LIMIT 1', [claimed]);
        if (direct.rowCount === 1) return direct.rows[0].id;
    }

    const providerCustomerId = customerReference(charge);
    if (providerCustomerId) {
        const mapped = await query(`
            SELECT customer_id
              FROM subscriptions
             WHERE source='stripe' AND provider_customer_id=$1
             ORDER BY created_at DESC
             LIMIT 2
        `, [providerCustomerId]);
        const ids = [...new Set(mapped.rows.map(row => String(row.customer_id || '')).filter(Boolean))];
        if (ids.length === 1) return ids[0];
    }

    const email = String(charge?.billing_details?.email || '').trim().toLowerCase();
    if (email) {
        const matched = await query(`
            SELECT c.id
              FROM customers c
              LEFT JOIN app_users u ON u.id=c.user_id
             WHERE lower(COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')))=$1
             LIMIT 2
        `, [email]);
        if (matched.rowCount === 1) return matched.rows[0].id;
    }
    return null;
}

async function expandedBalanceTransaction(stripe, charge) {
    const value = charge?.balance_transaction;
    if (!value) return null;
    if (typeof value === 'object') return value;
    return stripe.balanceTransactions.retrieve(String(value));
}

function historyValues(charge, balanceTransaction, customerId) {
    const amount = positiveInteger(charge?.amount);
    if (!charge?.id || !charge?.paid || amount == null || amount <= 0) return null;
    const fee = positiveInteger(balanceTransaction?.fee);
    const net = Number(balanceTransaction?.net);
    if (fee == null || !Number.isFinite(net)) return null;
    const metadata = mergedMetadata(charge);
    return {
        providerTransactionId: String(charge.id),
        status: String(charge.status || 'succeeded'),
        occurredAt: occurredAt(charge),
        currency: String(charge.currency || balanceTransaction?.currency || '').toUpperCase(),
        grossMinor: amount,
        feeMinor: fee,
        netMinor: Math.round(net),
        providerCustomerId: customerReference(charge),
        providerReferenceId: paymentIntentReference(charge),
        providerSourceId: invoiceReference(charge),
        customerId: customerId || null,
        metadata: {
            liveStripeSync: true,
            providerAuthoritative: true,
            feeDataAvailable: true,
            paymentIntentId: paymentIntentReference(charge),
            invoiceId: invoiceReference(charge),
            checkoutIntentId: metadata.internal_checkout_intent_id || null,
            planId: metadata.internal_plan_id || null
        }
    };
}

async function upsertCharge(stripe, charge) {
    const balanceTransaction = await expandedBalanceTransaction(stripe, charge);
    const customerId = await resolveCustomerId(charge);
    const values = historyValues(charge, balanceTransaction, customerId);
    if (!values || !values.currency) return { skipped: true, id: charge?.id || null };
    await query(`
        INSERT INTO payment_history_transactions(
            provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,
            gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,
            provider_reference_id,provider_source_id,customer_id,metadata
        ) VALUES(
            'stripe',$1,'charge',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb
        )
        ON CONFLICT(provider,provider_transaction_id) DO UPDATE SET
            transaction_type='charge',
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
        values.providerTransactionId, values.status, values.occurredAt, values.currency,
        values.grossMinor, values.feeMinor, values.netMinor, values.providerCustomerId,
        values.providerReferenceId, values.providerSourceId, values.customerId, JSON.stringify(values.metadata)
    ]);
    return { skipped: false, id: values.providerTransactionId, customerId: values.customerId };
}

async function runSync({ hours = DEFAULT_HOURS } = {}) {
    const boundedHours = Math.max(1, Math.min(MAX_HOURS, Number(hours) || DEFAULT_HOURS));
    const config = await providerSettings.get('stripe');
    const key = config?.restrictedKey || config?.apiKey || '';
    if (!key) return { configured: false, seen: 0, recorded: 0, skipped: 0, hours: boundedHours };
    const stripe = new Stripe(key, {
        apiVersion: '2026-06-24.dahlia',
        appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' },
        timeout: providerHttp.timeoutMs('stripe')
    });
    const since = Math.floor((Date.now() - boundedHours * 60 * 60 * 1000) / 1000);
    let startingAfter = null, pages = 0, seen = 0, recorded = 0, skipped = 0;
    while (true) {
        const response = await stripe.charges.list({
            limit: 100,
            created: { gte: since },
            expand: ['data.balance_transaction','data.payment_intent','data.invoice'],
            ...(startingAfter ? { starting_after: startingAfter } : {})
        });
        for (const charge of response.data || []) {
            seen += 1;
            const out = await upsertCharge(stripe, charge);
            if (out.skipped) skipped += 1; else recorded += 1;
        }
        pages += 1;
        if (!response.has_more) break;
        if (pages >= MAX_PAGES) throw new Error('Stripe payment-history sync exceeded its safe pagination limit.');
        const last = (response.data || [])[response.data.length - 1];
        if (!last?.id) throw new Error('Stripe payment-history sync could not continue pagination safely.');
        startingAfter = last.id;
    }
    return { configured: true, seen, recorded, skipped, hours: boundedHours };
}

async function syncRecent(options = {}) {
    const now = Date.now();
    if (!options.force && lastSyncAt && now - lastSyncAt < MIN_SYNC_INTERVAL_MS) return { cached: true };
    if (inFlight) return inFlight;
    inFlight = runSync(options)
        .then(result => { lastSyncAt = Date.now(); return result; })
        .finally(() => { inFlight = null; });
    return inFlight;
}

module.exports = {
    DEFAULT_HOURS, MAX_HOURS, MAX_PAGES, MIN_SYNC_INTERVAL_MS,
    objectId, mergedMetadata, historyValues, resolveCustomerId, expandedBalanceTransaction,
    upsertCharge, runSync, syncRecent
};
