'use strict';

const crypto = require('crypto');
const lifecycle = require('./lifecycle');
const providerPricing = require('./provider-plan-pricing');
const discounts = require('./discounts');
const incidents = require('./incidents');
const checkoutIntents = require('./checkout-intents');
const providerSettings = require('./provider-settings');
const referrals = require('../referrals');
const { query } = require('../db');

let stripeClient;
let stripeClientKey = null;
function apiKeyFrom(config) { return config?.restrictedKey || config?.apiKey || ''; }
function enabled() { return Boolean(apiKeyFrom(providerSettings.peek('stripe'))); }
async function getStripe() {
    const config = await providerSettings.get('stripe'), key = apiKeyFrom(config);
    if (!key) throw new Error('Stripe is not configured');
    if (!stripeClient || stripeClientKey !== key) {
        const Stripe = require('stripe');
        stripeClient = new Stripe(key, { apiVersion: '2026-06-24.dahlia', appInfo: { name: 'CAPTaINFiN', version: '1.0.0' } });
        stripeClientKey = key;
    }
    return stripeClient;
}
function randomIntegrationIdentifier() {
    const letters='abcdefghijklmnopqrstuvwxyz'; let suffix='';
    for (const byte of crypto.randomBytes(8)) suffix += letters[byte % letters.length];
    return `captainfin_${suffix}`;
}
function subscriptionPeriod(subscription) {
    const items=subscription?.items?.data||[], starts=items.map(i=>Number(i.current_period_start)).filter(Number.isFinite), ends=items.map(i=>Number(i.current_period_end)).filter(Number.isFinite);
    return { start: starts.length?new Date(Math.min(...starts)*1000):new Date(Number(subscription.created||Date.now()/1000)*1000), end: ends.length?new Date(Math.max(...ends)*1000):null };
}
async function ensureStripeCustomer(customerId,email) {
    const existing=await lifecycle.findPaymentCustomer(customerId,'stripe'); if(existing)return existing.provider_customer_id;
    const stripe=await getStripe(),customer=await stripe.customers.create({email:email||undefined,metadata:{internal_customer_id:customerId}});
    await lifecycle.ensurePaymentCustomer({customerId,provider:'stripe',providerCustomerId:customer.id}); return customer.id;
}
async function ensureStripeCoupon(discount,plan) {
    if(discount.stripe_coupon_id)return discount.stripe_coupon_id;
    const stripe=await getStripe(),params={duration:'once',name:discount.code};
    if(discount.discount_type==='percent')params.percent_off=discount.percent_off;
    else {params.amount_off=discount.fixed_off_minor;params.currency=String(discount.currency||plan.currency||'usd').toLowerCase();}
    const coupon=await stripe.coupons.create(params);await query('UPDATE discount_codes SET stripe_coupon_id=$1,updated_at=NOW() WHERE id=$2',[coupon.id,discount.id]);return coupon.id;
}
async function createCheckout({customerId,planCode,email,successUrl,cancelUrl,discountCode=null,checkoutMode=null,idempotencyKey=null,resolvedPlan=null,currency=null}) {
    const plan=resolvedPlan||await providerPricing.getProviderPlan(planCode,'stripe',checkoutMode,currency);if(!plan)throw new Error('This plan is not configured for the selected Stripe payment type and currency');
    const stripe=await getStripe(),stripeCustomerId=await ensureStripeCustomer(customerId,email),mode=plan.checkout_mode==='subscription'?'subscription':'payment';
    const metadata={internal_customer_id:customerId,internal_plan_id:plan.id,internal_plan_code:plan.code,...(plan.plan_price_id?{internal_plan_price_id:String(plan.plan_price_id)}:{}),...(plan.provider_mapping_id?{internal_provider_mapping_id:String(plan.provider_mapping_id)}:{}),...(idempotencyKey?{internal_checkout_intent_id:String(idempotencyKey)}:{})};
    const params={mode,customer:stripeCustomerId,line_items:[{price:plan.external_id,quantity:1}],success_url:successUrl,cancel_url:cancelUrl,metadata,integration_identifier:randomIntegrationIdentifier()};
    if(discountCode){const discount=await discounts.validateForCheckout({code:discountCode,planId:plan.id,planCode,customerId});if(discount.discount_type==='fixed'&&discount.currency&&String(discount.currency).toUpperCase()!==String(plan.currency).toUpperCase())throw new Error("That discount code's currency does not match this plan");const couponId=await ensureStripeCoupon(discount,plan);params.discounts=[{coupon:couponId}];metadata.internal_discount_code_id=discount.id;}
    if(mode==='subscription')params.subscription_data={metadata};else params.payment_intent_data={metadata};
    const session=idempotencyKey
        ? await stripe.checkout.sessions.create(params,{idempotencyKey:`checkout-${String(idempotencyKey)}`})
        : await stripe.checkout.sessions.create(params);
    return{id:session.id,url:session.url,mode};
}
async function createCustomerPortal({customerId,returnUrl}) {
    const mapping=await lifecycle.findPaymentCustomer(customerId,'stripe');if(!mapping)throw new Error('No Stripe customer exists for this account');
    const stripe=await getStripe(),session=await stripe.billingPortal.sessions.create({customer:mapping.provider_customer_id,return_url:returnUrl});return{url:session.url};
}
function extractInvoiceSubscriptionId(invoice) {
    const direct=typeof invoice?.subscription==='string'?invoice.subscription:invoice?.subscription?.id;if(direct)return direct;
    const parent=invoice?.parent?.subscription_details?.subscription;return typeof parent==='string'?parent:parent?.id||null;
}
async function checkoutContract(session) {
    const customerId=session.metadata?.internal_customer_id,planId=session.metadata?.internal_plan_id;
    if(!customerId||!planId)throw new Error('Stripe Checkout session is missing internal metadata');
    const stripe=await getStripe();
    const verified=await stripe.checkout.sessions.retrieve(session.id,{expand:['line_items.data.price']});
    if(!['paid','no_payment_required'].includes(verified.payment_status))throw new Error('Stripe Checkout session is not paid');
    const price=verified.line_items?.data?.[0]?.price||null,priceId=price?.id||null;
    const contract=await checkoutIntents.verifiedProviderContract({provider:'stripe',providerCheckoutId:verified.id,scope:'customer',ownerId:customerId,planId,checkoutMode:verified.mode,providerMappingId:priceId,amountMinor:verified.mode==='payment'?verified.amount_total:null,currency:verified.mode==='payment'?verified.currency:price?.currency});
    return{session:verified,customerId,planId,priceId,...contract};
}
async function activateCheckoutSession(session) {
    if(!['paid','no_payment_required'].includes(session.payment_status))return null;
    const contract=await checkoutContract(session),verified=contract.session,customerId=contract.customerId,planId=contract.planId;
    const providerCustomerId=typeof verified.customer==='string'?verified.customer:verified.customer?.id;
    if(verified.mode==='subscription'){
        const subscriptionId=typeof verified.subscription==='string'?verified.subscription:verified.subscription?.id;if(!subscriptionId)throw new Error('Stripe Checkout subscription ID is missing');
        const stripe=await getStripe(),subscription=await stripe.subscriptions.retrieve(subscriptionId,{expand:['items.data.price']}),period=subscriptionPeriod(subscription);
        const subscriptionPrice=subscription.items?.data?.[0]?.price?.id||null;
        if(contract.snapshot.providerMappingId&&subscriptionPrice&&String(contract.snapshot.providerMappingId)!==String(subscriptionPrice))throw new Error('Stripe subscription price does not match the checkout contract.');
        return lifecycle.activatePurchase({customerId,planId,provider:'stripe',providerCustomerId,providerSubscriptionId:subscription.id,providerStatus:subscription.status,periodStart:period.start,periodEnd:period.end,cancelAtPeriodEnd:Boolean(subscription.cancel_at_period_end),commercialSnapshot:contract.snapshot});
    }
    const paymentId=typeof verified.payment_intent==='string'?verified.payment_intent:verified.payment_intent?.id||verified.id;
    return lifecycle.activatePurchase({customerId,planId,provider:'stripe',providerCustomerId,providerSubscriptionId:paymentId,providerStatus:'active',commercialSnapshot:contract.snapshot});
}
async function syncSubscription(subscriptionId,statusOverride=null) {
    const stripe=await getStripe(),subscription=await stripe.subscriptions.retrieve(subscriptionId,{expand:['items.data.price']}),period=subscriptionPeriod(subscription);
    return lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:subscription.id,providerStatus:statusOverride||subscription.status,periodEnd:period.end,cancelAtPeriodEnd:Boolean(subscription.cancel_at_period_end)});
}

async function incidentContextForCharge(stripe,charge) {
    let metadata={...(charge?.metadata||{})},providerSubscriptionId=null;
    const paymentIntentId=typeof charge?.payment_intent==='string'?charge.payment_intent:charge?.payment_intent?.id||null;
    if(paymentIntentId){
        try{const pi=await stripe.paymentIntents.retrieve(paymentIntentId);metadata={...(pi?.metadata||{}),...metadata};}catch(_){}
    }
    const invoiceId=typeof charge?.invoice==='string'?charge.invoice:charge?.invoice?.id||null;
    if(invoiceId){try{const invoice=await stripe.invoices.retrieve(invoiceId);providerSubscriptionId=extractInvoiceSubscriptionId(invoice);}catch(_){} }
    if(!providerSubscriptionId&&paymentIntentId)providerSubscriptionId=paymentIntentId;
    let identity=await incidents.identityFromMetadata(metadata);
    if(identity.scope==='unresolved'&&providerSubscriptionId)identity=await incidents.identityFromProviderSubscription('stripe',providerSubscriptionId);
    return{identity,providerSubscriptionId,metadata,paymentIntentId,invoiceId};
}
async function reverseReferralForDirectIdentity(identity,incidentResult,reason,options={}){if(identity?.scope!=='direct'||!identity.customerId)return null;return referrals.revisitRewardAfterAdversePayment({referredCustomerId:identity.customerId,incidentId:incidentResult?.incident?.id||null,reason,...options});}
async function recordStripeRefund(event,stripe,charge) {
    const ctx=await incidentContextForCharge(stripe,charge),amount=Number(charge?.amount||0),refunded=Number(charge?.amount_refunded||0),fullRefund=amount>0&&refunded>=amount,recorded=await incidents.record({provider:'stripe',eventId:event.id,caseId:charge?.id||ctx.paymentIntentId,kind:'refund',status:'recorded',identity:ctx.identity,providerSubscriptionId:ctx.providerSubscriptionId,amountMinor:refunded,currency:charge?.currency,metadata:{...ctx.metadata,chargeId:charge?.id||null,fullRefund,originalAmountMinor:amount}});
    await reverseReferralForDirectIdentity(ctx.identity,recorded,`stripe:refund:${event.id}`,{amountMinor:refunded,fullLoss:fullRefund});return recorded;
}
async function recordStripeDispute(event,stripe,dispute) {
    let charge=null;try{charge=typeof dispute?.charge==='string'?await stripe.charges.retrieve(dispute.charge):dispute?.charge||null;}catch(_){}
    const ctx=await incidentContextForCharge(stripe,charge||{}),won=String(dispute?.status||'').toLowerCase()==='won',lost=String(dispute?.status||'').toLowerCase()==='lost',recorded=await incidents.record({provider:'stripe',eventId:event.id,caseId:dispute?.id||charge?.id,kind:lost?'chargeback':'dispute',status:won?'won':lost?'lost':'open',identity:ctx.identity,providerSubscriptionId:ctx.providerSubscriptionId,amountMinor:dispute?.amount,currency:dispute?.currency,metadata:{...ctx.metadata,disputeId:dispute?.id||null,reason:dispute?.reason||null,stripeStatus:dispute?.status||null}});
    if(lost)await reverseReferralForDirectIdentity(ctx.identity,recorded,`stripe:chargeback:${event.id}`,{amountMinor:dispute?.amount,fullLoss:true});return recorded;
}

async function processWebhook(rawBody,signature) {
    const config=await providerSettings.get('stripe'),secret=config.webhookSecret;if(!secret)throw new Error('Stripe webhook secret is not configured');
    const stripe=await getStripe(),event=stripe.webhooks.constructEvent(rawBody,signature,secret),eventRow=await lifecycle.beginPaymentEvent({provider:'stripe',eventId:event.id,eventType:event.type,payload:event});if(!eventRow)return{duplicate:true};
    try{
        const object=event.data?.object;
        switch(event.type){
            case 'checkout.session.completed': await activateCheckoutSession(object); break;
            case 'customer.subscription.updated':
            case 'customer.subscription.deleted': await syncSubscription(object.id); break;
            case 'invoice.paid': {const subscriptionId=extractInvoiceSubscriptionId(object);if(subscriptionId)await syncSubscription(subscriptionId,'active');break;}
            case 'invoice.payment_failed': {const subscriptionId=extractInvoiceSubscriptionId(object);if(subscriptionId){await syncSubscription(subscriptionId,'past_due');await incidents.record({provider:'stripe',eventId:event.id,caseId:object.id,kind:'failed_renewal',status:'open',providerSubscriptionId:subscriptionId,amountMinor:object.amount_due,currency:object.currency,metadata:{invoiceId:object.id}});}break;}
            case 'charge.refunded': await recordStripeRefund(event,stripe,object); break;
            case 'charge.dispute.created': await recordStripeDispute(event,stripe,object); break;
            case 'charge.dispute.closed': await recordStripeDispute(event,stripe,object); break;
            default: break;
        }
        await lifecycle.finishPaymentEvent(eventRow);return{duplicate:false,type:event.type};
    }catch(error){await lifecycle.finishPaymentEvent(eventRow,error);throw error;}
}
module.exports={enabled,createCheckout,createCustomerPortal,processWebhook,subscriptionPeriod,incidentContextForCharge,checkoutContract,activateCheckoutSession,recordStripeRefund,recordStripeDispute,reverseReferralForDirectIdentity};
