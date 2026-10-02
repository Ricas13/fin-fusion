'use strict';

const Stripe = require('stripe');
const { query } = require('../db');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const financialTruth = require('./provider-financial-truth');

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
function integer(value) {
    if (value == null || value === '') return null;
    const n = Number(value);
    return Number.isFinite(n) ? Math.round(n) : null;
}
function occurredAt(object, balanceTransaction) {
    const balanceCreated = Number(balanceTransaction?.created);
    if (Number.isFinite(balanceCreated) && balanceCreated > 0) return new Date(balanceCreated * 1000);
    const created = Number(object?.created);
    return Number.isFinite(created) && created > 0 ? new Date(created * 1000) : new Date();
}
function mergedMetadata(charge) {
    const paymentIntent = charge?.payment_intent && typeof charge.payment_intent === 'object' ? charge.payment_intent : null;
    return { ...(paymentIntent?.metadata || {}), ...(charge?.metadata || {}) };
}
function customerReference(charge) { return objectId(charge?.customer); }
function paymentIntentReference(charge) { return objectId(charge?.payment_intent); }
function invoiceReference(charge) { return objectId(charge?.invoice); }

async function resolveCustomerId(charge) {
    const metadata = mergedMetadata(charge);
    const generic = await financialTruth.resolveCustomerId({
        provider: 'stripe',
        customerId: metadata.internal_customer_id || null,
        providerCustomerId: customerReference(charge),
        providerTransactionId: objectId(charge?.balance_transaction),
        providerReferenceId: paymentIntentReference(charge),
        providerSourceId: charge?.id || null,
        providerCheckoutId: metadata.internal_checkout_intent_id || null,
        email: charge?.billing_details?.email || null
    });
    if (generic) return generic;

    // Imported pre-CAPTAiNFiN subscriptions can only expose the PaymentIntent
    // relationship through legacy_subscription_imports. Keep this as a final
    // compatibility bridge, then remember the recovered identity in the new
    // canonical graph when the ledger row is written.
    const paymentIntentId = paymentIntentReference(charge);
    if (paymentIntentId) {
        const legacy = await query(`
            SELECT DISTINCT customer_id
              FROM legacy_subscription_imports
             WHERE provider='stripe'
               AND provider_transaction_id=$1
               AND customer_id IS NOT NULL
             LIMIT 2
        `, [paymentIntentId]);
        if (legacy.rowCount === 1) return legacy.rows[0].customer_id;
    }
    return null;
}

async function expandedBalanceTransaction(stripe, charge) {
    const value = charge?.balance_transaction;
    if (!value) return null;
    if (typeof value === 'object') return value;
    return stripe.balanceTransactions.retrieve(String(value));
}

async function expandedRefundBalanceTransaction(stripe, refund) {
    const value = refund?.balance_transaction;
    if (!value) return null;
    if (typeof value === 'object') return value;
    return stripe.balanceTransactions.retrieve(String(value));
}

function historyValues(charge, balanceTransaction, customerId) {
    // Stripe balance transactions are the canonical accounting identity because
    // they own settlement currency, gross, fee and net.
    const amount = positiveInteger(balanceTransaction?.amount);
    if (!charge?.id || !charge?.paid || !balanceTransaction?.id || amount == null || amount <= 0) return null;

    const fee = positiveInteger(balanceTransaction?.fee);
    const net = integer(balanceTransaction?.net);
    if (fee == null || net == null) return null;

    const metadata = mergedMetadata(charge);
    return {
        providerTransactionId: String(balanceTransaction.id),
        status: String(balanceTransaction.status || charge.status || 'available'),
        occurredAt: occurredAt(charge, balanceTransaction),
        currency: String(balanceTransaction.currency || charge.currency || '').toUpperCase(),
        grossMinor: amount,
        feeMinor: fee,
        netMinor: net,
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

function refundHistoryValues(charge, refund, balanceTransaction, customerId) {
    if (!refund?.id || !balanceTransaction?.id) return null;
    const gross = integer(balanceTransaction.amount);
    const fee = integer(balanceTransaction.fee);
    const net = integer(balanceTransaction.net);
    if (gross == null || gross >= 0 || fee == null || net == null) return null;
    const metadata = mergedMetadata(charge);
    return {
        providerTransactionId: String(balanceTransaction.id),
        status: String(balanceTransaction.status || refund.status || 'available'),
        occurredAt: occurredAt(refund, balanceTransaction),
        currency: String(balanceTransaction.currency || refund.currency || charge?.currency || '').toUpperCase(),
        grossMinor: gross,
        feeMinor: fee,
        netMinor: net,
        providerCustomerId: customerReference(charge),
        providerReferenceId: String(refund.id),
        providerSourceId: String(charge?.id || ''),
        customerId: customerId || null,
        metadata: {
            liveStripeSync: true,
            providerAuthoritative: true,
            feeDataAvailable: true,
            stripeRefund: true,
            balanceTransactionId: String(balanceTransaction.id),
            refundId: String(refund.id),
            chargeId: String(charge?.id || ''),
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
    if (!values || !values.currency) return { skipped: true, id: charge?.id || null, refundsRecorded: 0 };
    const stored = await financialTruth.upsertTransaction({
        provider: 'stripe',
        providerTransactionId: values.providerTransactionId,
        transactionType: 'charge',
        transactionStatus: values.status,
        occurredAt: values.occurredAt,
        currency: values.currency,
        grossMinor: values.grossMinor,
        feeMinor: values.feeMinor,
        netMinor: values.netMinor,
        providerCustomerId: values.providerCustomerId,
        providerReferenceId: values.providerReferenceId,
        providerSourceId: values.providerSourceId,
        customerId: values.customerId,
        providerBillingReference: values.providerReferenceId,
        metadata: values.metadata,
        identitySource: 'stripe_charge'
    });
    const refundsRecorded = await syncChargeRefunds(stripe, charge, stored.customerId || customerId);
    return { skipped: false, id: values.providerTransactionId, customerId: stored.customerId || customerId, refundsRecorded };
}

async function listChargeRefunds(stripe, charge) {
    if (!charge?.id || Number(charge.amount_refunded || 0) <= 0) return [];
    const rows = [];
    let startingAfter = null;
    let pages = 0;
    while (true) {
        const response = await stripe.refunds.list({
            charge: String(charge.id),
            limit: 100,
            expand: ['data.balance_transaction'],
            ...(startingAfter ? { starting_after: startingAfter } : {})
        });
        rows.push(...(response.data || []));
        pages += 1;
        if (!response.has_more) break;
        if (pages >= MAX_PAGES) throw new Error(`Stripe refund sync exceeded its safe pagination limit for charge ${charge.id}.`);
        const last = (response.data || [])[response.data.length - 1];
        if (!last?.id) throw new Error('Stripe refund sync could not continue pagination safely.');
        startingAfter = last.id;
    }
    return rows;
}

async function syncChargeRefunds(stripe, charge, customerId = null) {
    const refunds = await listChargeRefunds(stripe, charge);
    let recorded = 0;
    for (const refund of refunds) {
        const balanceTransaction = await expandedRefundBalanceTransaction(stripe, refund);
        const owner = customerId || await resolveCustomerId(charge);
        const values = refundHistoryValues(charge, refund, balanceTransaction, owner);
        if (!values || !values.currency) continue;
        await financialTruth.upsertTransaction({
            provider: 'stripe',
            providerTransactionId: values.providerTransactionId,
            transactionType: 'refund',
            transactionStatus: values.status,
            occurredAt: values.occurredAt,
            currency: values.currency,
            grossMinor: values.grossMinor,
            feeMinor: values.feeMinor,
            netMinor: values.netMinor,
            providerCustomerId: values.providerCustomerId,
            providerReferenceId: values.providerReferenceId,
            providerSourceId: values.providerSourceId,
            customerId: values.customerId,
            providerBillingReference: paymentIntentReference(charge),
            metadata: values.metadata,
            identitySource: 'stripe_refund'
        });
        recorded += 1;
    }
    return recorded;
}

async function runSync({ hours = DEFAULT_HOURS } = {}) {
    const boundedHours = Math.max(1, Math.min(MAX_HOURS, Number(hours) || DEFAULT_HOURS));
    const config = await providerSettings.get('stripe');
    const key = config?.restrictedKey || config?.apiKey || '';
    if (!key) return { provider: 'stripe', configured: false, seen: 0, recorded: 0, refundsRecorded: 0, skipped: 0, hours: boundedHours };
    const stripe = new Stripe(key, {
        apiVersion: '2026-06-24.dahlia',
        appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' },
        timeout: providerHttp.timeoutMs('stripe')
    });
    const since = Math.floor((Date.now() - boundedHours * 60 * 60 * 1000) / 1000);
    let startingAfter = null, pages = 0, seen = 0, recorded = 0, refundsRecorded = 0, skipped = 0;
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
            if (out.skipped) skipped += 1;
            else {
                recorded += 1;
                refundsRecorded += Number(out.refundsRecorded || 0);
            }
        }
        pages += 1;
        if (!response.has_more) break;
        if (pages >= MAX_PAGES) throw new Error('Stripe payment-history sync exceeded its safe pagination limit.');
        const last = (response.data || [])[response.data.length - 1];
        if (!last?.id) throw new Error('Stripe payment-history sync could not continue pagination safely.');
        startingAfter = last.id;
    }
    return { provider: 'stripe', configured: true, seen, recorded, refundsRecorded, skipped, hours: boundedHours };
}

async function syncRecent(options = {}) {
    const now = Date.now();
    if (!options.force && lastSyncAt && now - lastSyncAt < MIN_SYNC_INTERVAL_MS) return { provider: 'stripe', cached: true };
    if (inFlight) return inFlight;
    inFlight = runSync(options)
        .then(result => { lastSyncAt = Date.now(); return result; })
        .finally(() => { inFlight = null; });
    return inFlight;
}

module.exports = {
    DEFAULT_HOURS, MAX_HOURS, MAX_PAGES, MIN_SYNC_INTERVAL_MS,
    objectId, mergedMetadata, historyValues, refundHistoryValues, resolveCustomerId,
    expandedBalanceTransaction, expandedRefundBalanceTransaction, listChargeRefunds,
    upsertCharge, syncChargeRefunds, runSync, syncRecent
};
