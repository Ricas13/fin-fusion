'use strict';

const Stripe = require('stripe');
const { query } = require('../db');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const financialState = require('./provider-financial-state');

const DEFAULT_HOURS = 24 * 7;
const MAX_HOURS = 24 * 30;
const MAX_PAGES = 100;
const MIN_SYNC_INTERVAL_MS = 60 * 1000;

let lastSyncAt = 0;
let inFlight = null;

function objectId(value) { return typeof value === 'string' ? value : value?.id || null; }
function positiveInteger(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
}
function occurredAt(charge, balanceTransaction) {
    const balanceCreated = Number(balanceTransaction?.created);
    if (Number.isFinite(balanceCreated) && balanceCreated > 0) return new Date(balanceCreated * 1000);
    const chargeCreated = Number(charge?.created);
    return Number.isFinite(chargeCreated) && chargeCreated > 0 ? new Date(chargeCreated * 1000) : new Date();
}
function mergedMetadata(charge) {
    const paymentIntent = charge?.payment_intent && typeof charge.payment_intent === 'object' ? charge.payment_intent : null;
    return { ...(paymentIntent?.metadata || {}), ...(charge?.metadata || {}) };
}
function customerReference(charge) { return objectId(charge?.customer); }
function paymentIntentReference(charge) { return objectId(charge?.payment_intent); }
function invoiceReference(charge) { return objectId(charge?.invoice); }

async function resolveCustomerId(charge) {
    const metadata=mergedMetadata(charge);
    const invoice=charge?.invoice&&typeof charge.invoice==='object'?charge.invoice:null;
    const subscriptionRef=invoice?.parent?.subscription_details?.subscription;
    const subscriptionId=objectId(subscriptionRef);
    return financialState.resolveCustomerId({
        provider:'stripe',
        internalCustomerId:metadata.internal_customer_id,
        checkoutIntentId:metadata.internal_checkout_intent_id,
        providerCustomerId:customerReference(charge),
        providerTransactionId:paymentIntentReference(charge),
        providerReferenceId:paymentIntentReference(charge),
        providerSourceId:charge?.id||null,
        providerReferences:[subscriptionId,invoiceReference(charge)],
        email:charge?.billing_details?.email||null
    });
}

async function expandedBalanceTransaction(stripe, charge) {
    const value = charge?.balance_transaction;
    if (!value) return null;
    if (typeof value === 'object') return value;
    return stripe.balanceTransactions.retrieve(String(value));
}

function historyValues(charge, balanceTransaction, customerId) {
    // This is an accounting ledger. Stripe's balance transaction is the
    // canonical identity and monetary source because it owns settlement
    // currency, gross, fee and net.
    const amount = positiveInteger(balanceTransaction?.amount);
    if (!charge?.id || !charge?.paid || !balanceTransaction?.id || amount == null || amount <= 0) return null;

    const fee = positiveInteger(balanceTransaction?.fee);
    const rawNet = balanceTransaction?.net;
    const net = rawNet == null || rawNet === '' ? Number.NaN : Number(rawNet);
    if (fee == null || !Number.isFinite(net)) return null;

    const metadata = mergedMetadata(charge);
    return {
        providerTransactionId: String(balanceTransaction.id),
        status: String(balanceTransaction.status || charge.status || 'available'),
        occurredAt: occurredAt(charge, balanceTransaction),
        currency: String(balanceTransaction.currency || charge.currency || '').toUpperCase(),
        grossMinor: amount,
        feeMinor: fee,
        netMinor: Math.round(net),
        providerCustomerId: customerReference(charge),
        providerReferenceId: paymentIntentReference(charge),
        providerSourceId: String(charge.id),
        customerId: customerId || null,
        metadata: {
            liveStripeSync: true,
            providerAuthoritative: true,
            feeDataAvailable: true,
            balanceTransactionId: String(balanceTransaction.id),
            chargeId: String(charge.id),
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
