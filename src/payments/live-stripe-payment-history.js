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

async function expandedRefundBalanceTransaction(stripe, refund) {
    const value=refund?.balance_transaction;
    if(!value)return null;
    if(typeof value==='object')return value;
    return stripe.balanceTransactions.retrieve(String(value));
}
function refundOccurredAt(refund,balanceTransaction){
    const balanceCreated=Number(balanceTransaction?.created);
    if(Number.isFinite(balanceCreated)&&balanceCreated>0)return new Date(balanceCreated*1000);
    const refundCreated=Number(refund?.created);
    return Number.isFinite(refundCreated)&&refundCreated>0?new Date(refundCreated*1000):new Date();
}
function refundHistoryValues(charge,refund,balanceTransaction,customerId){
    const amount=Number(balanceTransaction?.amount);
    const fee=Number(balanceTransaction?.fee);
    const net=Number(balanceTransaction?.net);
    if(!charge?.id||!refund?.id||String(refund.status||'').toLowerCase()!=='succeeded'||!balanceTransaction?.id
      ||!Number.isFinite(amount)||amount>=0||!Number.isFinite(fee)||!Number.isFinite(net))return null;
    const metadata=mergedMetadata(charge);
    return{
      providerTransactionId:String(balanceTransaction.id),
      status:String(balanceTransaction.status||refund.status||'available'),
      occurredAt:refundOccurredAt(refund,balanceTransaction),
      currency:String(balanceTransaction.currency||refund.currency||charge.currency||'').toUpperCase(),
      grossMinor:Math.round(amount),
      feeMinor:Math.round(fee),
      netMinor:Math.round(net),
      providerCustomerId:customerReference(charge),
      providerReferenceId:String(refund.id),
      providerSourceId:String(charge.id),
      customerId:customerId||null,
      metadata:{
        liveStripeSync:true,
        providerAuthoritative:true,
        feeDataAvailable:true,
        balanceTransactionId:String(balanceTransaction.id),
        refundId:String(refund.id),
        chargeId:String(charge.id),
        paymentIntentId:paymentIntentReference(charge),
        invoiceId:invoiceReference(charge),
        checkoutIntentId:metadata.internal_checkout_intent_id||null,
        planId:metadata.internal_plan_id||null
      }
    };
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
    const row=await financialState.recordTransaction({
        provider:'stripe',
        providerTransactionId:values.providerTransactionId,
        transactionType:'charge',
        transactionStatus:values.status,
        occurredAt:values.occurredAt,
        currency:values.currency,
        grossMinor:values.grossMinor,
        feeMinor:values.feeMinor,
        netMinor:values.netMinor,
        providerCustomerId:values.providerCustomerId,
        providerReferenceId:values.providerReferenceId,
        providerSourceId:values.providerSourceId,
        customerId:values.customerId,
        metadata:values.metadata
    });
    return { skipped: false, id: row.provider_transaction_id, customerId: row.customer_id || values.customerId };
}

async function upsertRefund(stripe, charge, refund, {customerId=null}={}) {
    const balanceTransaction=await expandedRefundBalanceTransaction(stripe,refund);
    const owner=customerId||await resolveCustomerId(charge);
    const values=refundHistoryValues(charge,refund,balanceTransaction,owner);
    if(!values||!values.currency)return{skipped:true,id:refund?.id||null};
    const row=await financialState.recordTransaction({
        provider:'stripe',
        providerTransactionId:values.providerTransactionId,
        transactionType:'refund',
        transactionStatus:values.status,
        occurredAt:values.occurredAt,
        currency:values.currency,
        grossMinor:values.grossMinor,
        feeMinor:values.feeMinor,
        netMinor:values.netMinor,
        providerCustomerId:values.providerCustomerId,
        providerReferenceId:values.providerReferenceId,
        providerSourceId:values.providerSourceId,
        customerId:values.customerId,
        metadata:values.metadata
    });
    return{skipped:false,id:row.provider_transaction_id,customerId:row.customer_id||values.customerId};
}

async function syncRecentRefunds(stripe,since){
    let startingAfter=null,pages=0,seen=0,recorded=0,skipped=0;
    while(true){
      const response=await stripe.refunds.list({
        limit:100,
        created:{gte:since},
        expand:['data.balance_transaction','data.charge'],
        ...(startingAfter?{starting_after:startingAfter}:{})
      });
      for(const refund of response.data||[]){
        seen+=1;
        if(String(refund?.status||'').toLowerCase()!=='succeeded'){skipped+=1;continue;}
        let charge=refund?.charge||null;
        if(typeof charge==='string'){
          charge=await stripe.charges.retrieve(charge,{expand:['payment_intent','invoice']});
        }
        if(!charge?.id){skipped+=1;continue;}
        const out=await upsertRefund(stripe,charge,refund);
        if(out.skipped)skipped+=1;else recorded+=1;
      }
      pages+=1;
      if(!response.has_more)break;
      if(pages>=MAX_PAGES)throw new Error('Stripe refund-history sync exceeded its safe pagination limit.');
      const last=(response.data||[])[response.data.length-1];
      if(!last?.id)throw new Error('Stripe refund-history sync could not continue pagination safely.');
      startingAfter=last.id;
    }
    return{seen,recorded,skipped,pages};
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
    const refunds=await syncRecentRefunds(stripe,since);
    return {
        configured:true,seen,recorded,skipped,hours:boundedHours,
        refundSeen:refunds.seen,refundRecorded:refunds.recorded,refundSkipped:refunds.skipped
    };
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
    objectId, mergedMetadata, historyValues, refundHistoryValues, resolveCustomerId,
    expandedBalanceTransaction, expandedRefundBalanceTransaction, upsertCharge, upsertRefund,
    syncRecentRefunds, runSync, syncRecent
};
