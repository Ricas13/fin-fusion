'use strict';

const liveStripeHistory = require('./live-stripe-payment-history');
const providerPaymentReconciliation = require('./provider-payment-reconciliation');
const financialState = require('./provider-financial-state');

const DEFAULT_HOURS = 72;

async function capture(label, fn) {
    try { return { provider: label, ok: true, result: await fn() }; }
    catch (error) { return { provider: label, ok: false, error: String(error?.message || error).slice(0,1000) }; }
}

async function syncRecent({ hours = DEFAULT_HOURS, force = true } = {}) {
    const before = await financialState.reconcileLocalEvidence();
    const [stripe,paypal,plisio] = await Promise.all([
        capture('stripe',()=>liveStripeHistory.syncRecent({hours,force})),
        capture('paypal',()=>providerPaymentReconciliation.syncRecentPayPalHistory({hours,limit:500})),
        capture('plisio',()=>require('./plisio').syncFeeData({limit:25}))
    ]);
    const after = await financialState.reconcileLocalEvidence();
    const providers=[stripe,paypal,plisio];
    const failed=providers.filter(item=>!item.ok).length;
    const warnings=providers.filter(item=>!item.ok).map(item=>`${item.provider}: ${item.error}`);
    for(const item of providers){
        const warning=item.result?.warning;
        if(warning)warnings.push(`${item.provider}: ${warning}`);
    }
    return{
        processed:Number(before.processed||0)+Number(after.processed||0)+providers.reduce((n,item)=>n+Number(item.result?.processed||item.result?.seen||0),0),
        failed,
        providers,
        local:{before,after},
        warning:warnings.length?warnings.join(' ').slice(0,2000):null
    };
}

module.exports={DEFAULT_HOURS,syncRecent};
