'use strict';

const crypto = require('crypto');
const lifecycle = require('./lifecycle');
const providerPricing = require('./provider-plan-pricing');
const discounts = require('./discounts');
const incidents = require('./incidents');
const failedRenewals = require('./failed-renewals');
const checkoutIntents = require('./checkout-intents');
const renewalCredits = require('./service-credit-renewals');
const providerSettings = require('./provider-settings');
const providerHttp = require('./provider-http');
const referrals = require('../referrals');
const { query } = require('../db');

let stripeClient;
let stripeClientKey = null;
function apiKeyFrom(config) { return config?.restrictedKey || config?.apiKey || ''; }
function enabled() { return Boolean(apiKeyFrom(providerSettings.peek('stripe'))); }
function classifyStripeError(error) { const details=providerHttp.classifySdkError('stripe',error);if(error&&typeof error==='object'){error.provider='stripe';error.retryable=details.retryable;error.requestId=details.requestId;error.status=details.status;}return error; }
async function getStripe() {
    const config = await providerSettings.get('stripe'), key = apiKeyFrom(config);
    if (!key) throw new Error('Stripe is not configured');
    if (!stripeClient || stripeClientKey !== key) {
        const Stripe = require('stripe');
        stripeClient = new Stripe(key, { apiVersion: '2026-06-24.dahlia', appInfo: { name: 'CAPTAiNFiN', version: '1.0.0' }, timeout: providerHttp.timeoutMs('stripe') });
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
async function createCheckout({customerId,planCode,email,successUrl,cancelUrl,discountCode=null,checkoutMode=null,idempotencyKey=null,resolvedPlan=null,currency=null,finalAmountMinor=null,checkoutExpiresAt=null,commercialSnapshot=null}) {
    const plan=resolvedPlan||await providerPricing.getProviderPlan(planCode,'stripe',checkoutMode,currency);if(!plan)throw new Error('This plan is not configured for the selected Stripe payment type and currency');
    const stripe=await getStripe(),stripeCustomerId=await ensureStripeCustomer(customerId,email),mode=plan.checkout_mode==='subscription'?'subscription':'payment',baseMinor=Number(plan.price_minor||0),finalMinor=finalAmountMinor==null?null:Number(finalAmountMinor);
    if(mode==='subscription'&&!plan.external_id)throw new Error('This Stripe recurring option has no Price ID');
    if(finalMinor!=null&&(!Number.isInteger(finalMinor)||finalMinor<50||finalMinor>baseMinor))throw new Error('Adjusted Stripe checkout amount is invalid.');
    const metadata={internal_customer_id:customerId,internal_plan_id:plan.id,internal_plan_code:plan.code,...(plan.plan_price_id?{internal_plan_price_id:String(plan.plan_price_id)}:{}),...(plan.provider_mapping_id?{internal_provider_mapping_id:String(plan.provider_mapping_id)}:{}),...(idempotencyKey?{internal_checkout_intent_id:String(idempotencyKey)}:{})};
    const lineItem=mode==='payment'?{price_data:{currency:String(plan.currency||'GBP').toLowerCase(),unit_amount:baseMinor,product_data:{name:plan.name}},quantity:1}:{price:plan.external_id,quantity:1};
    const params={mode,customer:stripeCustomerId,line_items:[lineItem],success_url:successUrl,cancel_url:cancelUrl,metadata,integration_identifier:randomIntegrationIdentifier()};
    if(finalMinor!=null&&finalMinor<baseMinor){const coupon=await stripe.coupons.create({duration:'once',name:'CAPTAiNFiN checkout adjustment',amount_off:baseMinor-finalMinor,currency:String(plan.currency||'GBP').toLowerCase()});params.discounts=[{coupon:coupon.id}];if(commercialSnapshot?.discountCodeId)metadata.internal_discount_code_id=String(commercialSnapshot.discountCodeId);}
    else if(discountCode){const discount=await discounts.validateForCheckout({code:discountCode,planId:plan.id,planCode,customerId});if(discount.discount_type==='fixed'&&discount.currency&&String(discount.currency).toUpperCase()!==String(plan.currency).toUpperCase())throw new Error("That discount code's currency does not match this plan");const couponId=await ensureStripeCoupon(discount,plan);params.discounts=[{coupon:couponId}];metadata.internal_discount_code_id=discount.id;}
    if(checkoutExpiresAt){const epoch=Math.floor(new Date(checkoutExpiresAt).getTime()/1000),now=Math.floor(Date.now()/1000);if(Number.isFinite(epoch)&&epoch>=now+30*60&&epoch<=now+24*60*60)params.expires_at=epoch;}
    if(mode==='subscription')params.subscription_data={metadata};else params.payment_intent_data={metadata};
    const session=idempotencyKey?await stripe.checkout.sessions.create(params,{idempotencyKey:`checkout-${String(idempotencyKey)}`}):await stripe.checkout.sessions.create(params);return{id:session.id,url:session.url,mode};
}
async function createCustomerPortal({customerId,returnUrl}) {
    const mapping=await lifecycle.findPaymentCustomer(customerId,'stripe');if(!mapping)throw new Error('No Stripe customer exists for this account');
    const stripe=await getStripe(),session=await stripe.billingPortal.sessions.create({customer:mapping.provider_customer_id,return_url:returnUrl});return{url:session.url};
}
function extractInvoiceSubscriptionId(invoice) {
    const direct=typeof invoice?.subscription==='string'?invoice.subscription:invoice?.subscription?.id;if(direct)return direct;
    const parent=invoice?.parent?.subscription_details?.subscription;return typeof parent==='string'?parent:parent?.id||null;
}
function terminalStripeStatus(status) {
    return ['canceled','cancelled','incomplete_expired'].includes(String(status||'').toLowerCase());
}
function effectiveSyncStatus(remoteStatus,statusOverride=null) {
    const remote=String(remoteStatus||'').toLowerCase(),override=String(statusOverride||'').toLowerCase();
    if(terminalStripeStatus(remote))return remoteStatus;
    // A historical failed-invoice webhook must never overwrite a provider state
    // that has already recovered. The current provider read is authoritative.
    if(override==='past_due'&&['active','trialing'].includes(remote))return remoteStatus;
    return statusOverride||remoteStatus;
}
function stripeObjectId(value){return typeof value==='string'?value:value?.id||null;}
function serviceCreditLine(lines,reservationId){return(lines?.data||[]).find(line=>String(line?.metadata?.captainfin_service_credit_reservation_id||'')===String(reservationId))||null;}
function serviceCreditLineReference(line){return stripeObjectId(line?.invoice_item)||stripeObjectId(line?.parent?.invoice_item_details?.invoice_item)||line?.id||null;}
async function applyServiceCreditToRenewalInvoice(invoice,stripe){
    if(!invoice?.id||String(invoice.billing_reason||'')!=='subscription_cycle')return{applied:false,reason:'not_subscription_cycle'};
    let live=await stripe.invoices.retrieve(invoice.id);
    if(String(live.status||'')!=='draft'){
        await renewalCredits.releaseStripeInvoice(live.id,'invoice_not_draft_before_service_credit').catch(()=>{});
        return{applied:false,reason:'invoice_not_draft'};
    }
    if(live.automatic_tax?.enabled)return{applied:false,reason:'automatic_tax_not_supported'};
    const providerSubscriptionId=extractInvoiceSubscriptionId(live),customerId=stripeObjectId(live.customer),amountDue=Math.max(0,Number(live.amount_due||0)),currency=String(live.currency||'').toUpperCase();
    if(!providerSubscriptionId||!customerId||!currency||amountDue<=0)return{applied:false,reason:'invoice_incomplete'};
    const reservation=await renewalCredits.reserveStripeInvoice({providerInvoiceId:live.id,providerSubscriptionId,currency,maxAmountMinor:amountDue});
    if(!reservation?.reserved||Number(reservation.amountMinor||0)<=0)return{applied:false,reason:reservation?.reason||reservation?.state||'no_available_credit'};
    if(reservation.state==='provider_applied'||reservation.state==='consumed')return{applied:true,reservation,providerAdjustmentId:reservation.providerAdjustmentId||null,existing:true};
    try{
        const item=await stripe.invoiceItems.create({
            customer:customerId,
            invoice:live.id,
            amount:-Number(reservation.amountMinor),
            currency:String(reservation.currency||currency).toLowerCase(),
            description:'CAPTAiNFiN service credit',
            discountable:false,
            metadata:{
                captainfin_service_credit:'true',
                captainfin_service_credit_reservation_id:String(reservation.id),
                internal_customer_id:String(reservation.customerId),
                internal_subscription_id:String(reservation.subscriptionId)
            }
        },{idempotencyKey:`service-credit-renewal-${reservation.id}`});
        const saved=await renewalCredits.markStripeApplied({providerInvoiceId:live.id,providerAdjustmentId:item.id});
        return{applied:true,reservation:saved||reservation,providerAdjustmentId:item.id};
    }catch(error){
        try{
            live=await stripe.invoices.retrieve(invoice.id);
            if(String(live.status||'')!=='draft'){
                await renewalCredits.releaseStripeInvoice(invoice.id,'invoice_finalized_before_service_credit_adjustment');
                return{applied:false,reason:'invoice_finalized_before_adjustment'};
            }
        }catch(_){}
        throw error;
    }
}
async function settlePaidServiceCreditInvoice(invoice,stripe){
    if(!invoice?.id)return null;
    const reservation=await renewalCredits.reservationForStripeInvoice(invoice.id);
    if(!reservation||reservation.state==='consumed'||reservation.state==='released')return reservation;
    let adjustmentId=reservation.providerAdjustmentId;
    if(!adjustmentId){
        const live=await stripe.invoices.retrieve(invoice.id,{expand:['lines']});
        const line=serviceCreditLine(live.lines,reservation.id);
        if(!line){
            await renewalCredits.releaseStripeInvoice(invoice.id,'paid_without_service_credit_adjustment');
            return{...reservation,state:'released'};
        }
        const applied=Math.abs(Number(line.amount||0));
        if(applied!==Number(reservation.amountMinor))throw new Error(`Stripe renewal service-credit amount mismatch for invoice ${invoice.id}: reserved ${reservation.amountMinor}, provider ${applied}.`);
        adjustmentId=serviceCreditLineReference(line);
        if(!adjustmentId)throw new Error(`Stripe renewal service-credit line for invoice ${invoice.id} has no provider reference.`);
        await renewalCredits.markStripeApplied({providerInvoiceId:invoice.id,providerAdjustmentId:adjustmentId});
    }
    return renewalCredits.consumeStripeInvoice({providerInvoiceId:invoice.id,providerAdjustmentId:adjustmentId});
}
async function checkoutContract(session) {
    const customerId=session.metadata?.internal_customer_id,planId=session.metadata?.internal_plan_id;
    if(!customerId||!planId)throw new Error('Stripe Checkout session is missing internal metadata');
    const stripe=await getStripe();
    const verified=await stripe.checkout.sessions.retrieve(session.id,{expand:['line_items.data.price']});
    if(!['paid','no_payment_required'].includes(verified.payment_status))throw new Error('Stripe Checkout session is not paid');
    const price=verified.line_items?.data?.[0]?.price||null,priceId=price?.id||null;
    const contract=await checkoutIntents.verifiedProviderContract({provider:'stripe',providerCheckoutId:verified.id,scope:'customer',ownerId:customerId,planId,checkoutMode:verified.mode,providerMappingId:verified.mode==='subscription'?priceId:null,amountMinor:verified.mode==='payment'?verified.amount_total:null,currency:verified.mode==='payment'?verified.currency:price?.currency});
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
        const activated=await lifecycle.activatePurchase({customerId,planId,provider:'stripe',providerCustomerId,providerSubscriptionId:subscription.id,providerStatus:subscription.status,periodStart:period.start,periodEnd:period.end,cancelAtPeriodEnd:Boolean(subscription.cancel_at_period_end),commercialSnapshot:contract.snapshot});
        await checkoutIntents.completeVerifiedProvider('stripe',verified.id,'completed');return activated;
    }
    const paymentId=typeof verified.payment_intent==='string'?verified.payment_intent:verified.payment_intent?.id||verified.id;
    const activated=await lifecycle.activatePurchase({customerId,planId,provider:'stripe',providerCustomerId,providerSubscriptionId:paymentId,providerStatus:'active',commercialSnapshot:contract.snapshot});
    await checkoutIntents.completeVerifiedProvider('stripe',verified.id,'completed');return activated;
}
async function confirmCheckout(sessionId){
    const stripe=await getStripe(),session=await stripe.checkout.sessions.retrieve(String(sessionId||''));
    if(!session?.id)throw new Error('Stripe Checkout session was not found.');
    if(['paid','no_payment_required'].includes(String(session.payment_status||''))){const subscription=await activateCheckoutSession(session);return{completed:true,waiting:false,status:'completed',sessionId:session.id,subscription};}
    if(String(session.status||'').toLowerCase()==='expired'){await checkoutIntents.completeVerifiedProvider('stripe',session.id,'cancelled');return{completed:false,waiting:false,status:'expired',sessionId:session.id};}
    return{completed:false,waiting:true,status:String(session.payment_status||session.status||'processing').toLowerCase(),sessionId:session.id};
}
async function syncSubscription(subscriptionId,statusOverride=null) {
    const stripe=await getStripe(),subscription=await stripe.subscriptions.retrieve(subscriptionId,{expand:['items.data.price']}),period=subscriptionPeriod(subscription);
    const effectiveStatus=effectiveSyncStatus(subscription.status,statusOverride);
    const row=await lifecycle.updateProviderSubscription({provider:'stripe',providerSubscriptionId:subscription.id,providerStatus:effectiveStatus,periodEnd:period.end,cancelAtPeriodEnd:Boolean(subscription.cancel_at_period_end)});
    return{row,providerStatus:String(subscription.status||'').toLowerCase(),effectiveStatus:String(effectiveStatus||'').toLowerCase()};
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

async function handleWebhookEvent(event) {
    const stripe=await getStripe(),object=event.data?.object;
    switch(event.type){
        case 'checkout.session.completed': await activateCheckoutSession(object); break;
        case 'checkout.session.expired': if(object?.id)await checkoutIntents.completeVerifiedProvider('stripe',object.id,'cancelled'); break;
        case 'customer.subscription.updated': {
            const synced=await syncSubscription(object.id);
            if(synced.row&&['active','trialing'].includes(synced.effectiveStatus))await failedRenewals.resolveOpen({provider:'stripe',providerSubscriptionId:object.id,note:'Stripe subscription recovered and is active again.'});
            break;
        }
        case 'customer.subscription.deleted': {
            await syncSubscription(object.id);
            await failedRenewals.resolveOpen({provider:'stripe',providerSubscriptionId:object.id,note:'Stripe subscription ended; the failed renewal is no longer an operator action.'});
            break;
        }
        case 'invoice.created': {
            await applyServiceCreditToRenewalInvoice(object,stripe);
            break;
        }
        case 'invoice.paid': {
            const subscriptionId=extractInvoiceSubscriptionId(object);
            if(subscriptionId){
                const synced=await syncSubscription(subscriptionId,'active');
                if(synced.row&&['active','trialing'].includes(synced.effectiveStatus))await failedRenewals.resolveOpen({provider:'stripe',providerSubscriptionId:subscriptionId,providerCaseId:object.id,note:'Stripe invoice was paid and the subscription recovered.'});
                else if(terminalStripeStatus(synced.providerStatus))await failedRenewals.resolveOpen({provider:'stripe',providerSubscriptionId:subscriptionId,providerCaseId:object.id,note:'Stripe subscription is already terminal; this invoice event cannot restore it.'});
            }
            await settlePaidServiceCreditInvoice(object,stripe);
            break;
        }
        case 'invoice.payment_failed': {
            const subscriptionId=extractInvoiceSubscriptionId(object);
            if(subscriptionId){
                const synced=await syncSubscription(subscriptionId,'past_due');
                if(terminalStripeStatus(synced.providerStatus)){
                    await failedRenewals.resolveOpen({provider:'stripe',providerSubscriptionId:subscriptionId,providerCaseId:object.id,note:'Stripe subscription is already cancelled; this late failed-invoice retry is historical only.'});
                }else if(['active','trialing'].includes(synced.effectiveStatus)){
                    await failedRenewals.resolveOpen({provider:'stripe',providerSubscriptionId:subscriptionId,providerCaseId:object.id,note:'Stripe subscription is already healthy; this late failed-invoice event is historical only.'});
                }else{
                    await failedRenewals.record({provider:'stripe',eventId:event.id,caseId:object.id,providerSubscriptionId:subscriptionId,amountMinor:object.amount_due,currency:object.currency,metadata:{invoiceId:object.id}});
                }
            }
            break;
        }
        case 'invoice.voided': if(object?.id)await renewalCredits.releaseStripeInvoice(object.id,'invoice_voided'); break;
        case 'invoice.deleted': if(object?.id)await renewalCredits.releaseStripeInvoice(object.id,'invoice_deleted'); break;
        case 'invoice.marked_uncollectible': if(object?.id)await renewalCredits.releaseStripeInvoice(object.id,'invoice_marked_uncollectible'); break;
        case 'charge.refunded': await recordStripeRefund(event,stripe,object); break;
        case 'charge.dispute.created': await recordStripeDispute(event,stripe,object); break;
        case 'charge.dispute.closed': await recordStripeDispute(event,stripe,object); break;
        default: break;
    }
}
async function processClaimedEvent(eventRow,event){try{await handleWebhookEvent(event);await lifecycle.finishPaymentEvent(eventRow);return{processed:true};}catch(error){classifyStripeError(error);await lifecycle.finishPaymentEvent(eventRow,error);console.error('Stripe webhook processing deferred to internal retry:',error.message,providerHttp.safeErrorFields(error));return{processed:false,error};}}
async function processWebhook(rawBody,signature) {
    const config=await providerSettings.get('stripe'),secret=config.webhookSecret;if(!secret)throw new Error('Stripe webhook secret is not configured');
    const stripe=await getStripe(),event=stripe.webhooks.constructEvent(rawBody,signature,secret),eventRow=await lifecycle.beginPaymentEvent({provider:'stripe',eventId:event.id,eventType:event.type,payload:event});if(!eventRow)return{duplicate:true};
    const outcome=await processClaimedEvent(eventRow,event);return{duplicate:false,type:event.type,processingError:outcome.processed?null:String(outcome.error?.message||outcome.error||'processing failed')};
}
async function retryPaymentEvent(eventRow){if(!eventRow||eventRow.provider!=='stripe')throw new Error('Stripe retry received the wrong payment event.');const event=eventRow.payload;if(!event||String(event.id||'')!==String(eventRow.provider_event_id||''))throw new Error('Stored Stripe payment event payload does not match its event ID.');return processClaimedEvent(eventRow,event);}
module.exports={enabled,createCheckout,createCustomerPortal,processWebhook,retryPaymentEvent,handleWebhookEvent,subscriptionPeriod,incidentContextForCharge,checkoutContract,activateCheckoutSession,confirmCheckout,recordStripeRefund,recordStripeDispute,reverseReferralForDirectIdentity,effectiveSyncStatus,terminalStripeStatus,applyServiceCreditToRenewalInvoice,settlePaidServiceCreditInvoice,serviceCreditLine};
