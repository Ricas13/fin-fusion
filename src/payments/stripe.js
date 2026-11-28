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
const mappingVerification = require('./provider-mapping-verification');
const providerHttp = require('./provider-http');
const providerLifecycleState = require('./provider-lifecycle-state');
const financialState = require('./provider-financial-state');
const referrals = require('../referrals');
const { query } = require('../db');

let stripeClient;
let stripeClientKey = null;
function apiKeyFrom(config) { return config?.restrictedKey || config?.apiKey || ''; }
// enabled(): may this provider start NEW checkouts (credentials present and not switched off).
function enabled() { return Boolean(apiKeyFrom(providerSettings.peek('stripe'))); }
// operational(): can this provider still be used to settle, refund, sync and recover money that already moved.
// Switching Stripe off for new sales must never stop webhook processing for existing customers.
function operational() { return Boolean(apiKeyFrom(providerSettings.peekOperational('stripe'))); }
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
    const stripe=await getStripe(),customer=await stripe.customers.create({email:email||undefined,metadata:{internal_customer_id:customerId}},{idempotencyKey:`captainfin-customer-${String(customerId)}`});
    await lifecycle.ensurePaymentCustomer({customerId,provider:'stripe',providerCustomerId:customer.id}); return customer.id;
}
async function ensureStripeCoupon(discount,plan) {
    if(discount.stripe_coupon_id)return discount.stripe_coupon_id;
    const stripe=await getStripe(),params={duration:'once',name:discount.code};
    if(discount.discount_type==='percent')params.percent_off=discount.percent_off;
    else {params.amount_off=discount.fixed_off_minor;params.currency=String(discount.currency||plan.currency||'usd').toLowerCase();}
    const coupon=await stripe.coupons.create(params,{idempotencyKey:`captainfin-discount-coupon-${String(discount.id)}`});await query('UPDATE discount_codes SET stripe_coupon_id=$1,updated_at=NOW() WHERE id=$2',[coupon.id,discount.id]);return coupon.id;
}
async function createCheckout({customerId,planCode,email,successUrl,cancelUrl,discountCode=null,checkoutMode=null,idempotencyKey=null,resolvedPlan=null,currency=null,finalAmountMinor=null,checkoutExpiresAt=null,commercialSnapshot=null,allowZeroInitialRecurring=false}) {
    const plan=resolvedPlan||await providerPricing.getProviderPlan(planCode,'stripe',checkoutMode,currency);if(!plan)throw new Error('This plan is not configured for the selected Stripe payment type and currency');
    const stripe=await getStripe(),stripeCustomerId=await ensureStripeCustomer(customerId,email),mode=plan.checkout_mode==='subscription'?'subscription':'payment',baseMinor=Number(plan.price_minor||0),finalMinor=finalAmountMinor==null?null:Number(finalAmountMinor);
    if(mode==='subscription'&&!plan.external_id)throw new Error('This Stripe recurring option has no Price ID');
    const zeroInitial=allowZeroInitialRecurring===true&&mode==='subscription'&&finalMinor===0&&Boolean(idempotencyKey)&&baseMinor>0&&commercialSnapshot?.discountedMinor===0&&(Number(commercialSnapshot?.serviceCreditMinor)>0||Boolean(commercialSnapshot?.discountCodeId));
    if(finalMinor!=null&&(!Number.isInteger(finalMinor)||(!zeroInitial&&finalMinor<50)||finalMinor>baseMinor))throw new Error('Adjusted Stripe checkout amount is invalid.');
    const metadata={internal_customer_id:customerId,internal_plan_id:plan.id,internal_plan_code:plan.code,...(plan.plan_price_id?{internal_plan_price_id:String(plan.plan_price_id)}:{}),...(plan.provider_mapping_id?{internal_provider_mapping_id:String(plan.provider_mapping_id)}:{}),...(idempotencyKey?{internal_checkout_intent_id:String(idempotencyKey)}:{})};
    const lineItem=mode==='payment'?{price_data:{currency:String(plan.currency||'GBP').toLowerCase(),unit_amount:baseMinor,product_data:{name:plan.name}},quantity:1}:{price:plan.external_id,quantity:1};
    const params={mode,customer:stripeCustomerId,line_items:[lineItem],success_url:successUrl,cancel_url:cancelUrl,metadata,integration_identifier:randomIntegrationIdentifier()};
    if(zeroInitial)params.payment_method_collection='always';
    if(finalMinor!=null&&finalMinor<baseMinor){
        const stableAdjustmentKey=idempotencyKey
            ? `captainfin-checkout-adjustment-${String(idempotencyKey)}`
            : `captainfin-checkout-adjustment-${crypto.createHash('sha256').update(`${customerId}:${plan.id}:${baseMinor}:${finalMinor}:${String(plan.currency||'GBP').toUpperCase()}`).digest('hex')}`;
        const coupon=await stripe.coupons.create({duration:'once',name:'CAPTAiNFiN checkout adjustment',amount_off:baseMinor-finalMinor,currency:String(plan.currency||'GBP').toLowerCase()},{idempotencyKey:stableAdjustmentKey});params.discounts=[{coupon:coupon.id}];if(commercialSnapshot?.discountCodeId)metadata.internal_discount_code_id=String(commercialSnapshot.discountCodeId);
    }
    else if(discountCode){const discount=await discounts.validateForCheckout({code:discountCode,planId:plan.id,planCode,customerId});if(discount.discount_type==='fixed'&&discount.currency&&String(discount.currency).toUpperCase()!==String(plan.currency).toUpperCase())throw new Error("That discount code's currency does not match this plan");const couponId=await ensureStripeCoupon(discount,plan);params.discounts=[{coupon:couponId}];metadata.internal_discount_code_id=discount.id;}
    if(checkoutExpiresAt){const epoch=Math.floor(new Date(checkoutExpiresAt).getTime()/1000),now=Math.floor(Date.now()/1000);if(Number.isFinite(epoch)&&epoch>=now+30*60&&epoch<=now+24*60*60)params.expires_at=epoch;}
    if(mode==='subscription')params.subscription_data={metadata};else params.payment_intent_data={metadata};
    const session=idempotencyKey?await stripe.checkout.sessions.create(params,{idempotencyKey:`checkout-${String(idempotencyKey)}`}):await stripe.checkout.sessions.create(params);return{id:session.id,url:session.url,mode};
}
// Find the Checkout Session that a local intent created, by the exact intent id written into its metadata at creation.
// Used when the create call's outcome was lost (timeout/network/5xx): the session may or may not exist. Returns
//  - {session}     an open session for this intent (safe to attach and redirect to),
//  - {none:true}   no session for this intent exists or all were expired (nothing can be paid),
//  - {unconfirmed:true,reason} provider state could not be established (callers must keep reservations),
//  - {completed:true,sessionId} the session was already paid (callers must not release anything; the webhook binds it).
async function recoverUnattachedCheckout({customerId,intentId}) {
    try {
        const mapping=await lifecycle.findPaymentCustomer(customerId,'stripe');
        if(!mapping)return{none:true};
        const stripe=await getStripe();
        let startingAfter=null,open=null;
        for(let page=0;page<4;page+=1){
            const list=await stripe.checkout.sessions.list({customer:mapping.provider_customer_id,limit:50,...(startingAfter?{starting_after:startingAfter}:{})});
            for(const session of list.data||[]){
                if(String(session.metadata?.internal_checkout_intent_id||'')!==String(intentId))continue;
                if(session.status==='complete')return{completed:true,sessionId:session.id};
                if(session.status==='open'&&!open)open=session;
            }
            if(!list.has_more||!(list.data||[]).length)break;
            startingAfter=list.data[list.data.length-1].id;
        }
        if(open&&open.url)return{session:{id:open.id,url:open.url,mode:open.mode==='subscription'?'subscription':'payment'}};
        if(open){await stripe.checkout.sessions.expire(open.id);}
        return{none:true};
    }catch(error){
        return{unconfirmed:true,reason:String(error?.message||error).slice(0,300)};
    }
}
async function resumeCheckout(sessionId) {
    const id=String(sessionId||'').trim();
    if(!/^cs_/i.test(id))return null;

    const stripe=await getStripe();
    const session=await stripe.checkout.sessions.retrieve(id);
    if(!session?.id)return null;

    const status=String(session.status||'').toLowerCase();
    const paymentStatus=String(session.payment_status||'').toLowerCase();

    if(status==='open'&&session.url){
        return{
            id:session.id,
            url:session.url,
            mode:session.mode,
            resumed:true,
            status
        };
    }

    if(status==='complete'&&['paid','no_payment_required'].includes(paymentStatus)){
        await activateCheckoutSession(session);
        return{
            internal:true,
            message:'Payment confirmed. Your access has been updated.'
        };
    }

    if(status==='expired'){
        await checkoutIntents.completeVerifiedProvider('stripe',session.id,'cancelled');
        return null;
    }

    return null;
}

async function abandonCheckout(sessionId) {
    const id=String(sessionId||'').trim();
    if(!/^cs_/i.test(id))return{terminal:false,status:'invalid'};

    const stripe=await getStripe();
    let session=await stripe.checkout.sessions.retrieve(id);
    if(!session?.id)return{terminal:false,status:'missing'};

    let status=String(session.status||'').toLowerCase();
    let paymentStatus=String(session.payment_status||'').toLowerCase();

    if(status==='expired'){
        await checkoutIntents.completeVerifiedProvider('stripe',session.id,'cancelled');
        return{terminal:true,cancelled:true,status,paymentStatus};
    }

    if(status==='complete'&&['paid','no_payment_required'].includes(paymentStatus)){
        await activateCheckoutSession(session);
        return{terminal:true,completed:true,internal:true,message:'Payment confirmed. Your access has been updated.',status,paymentStatus};
    }

    if(status!=='open')return{terminal:false,status,paymentStatus};

    try{
        session=await stripe.checkout.sessions.expire(id);
    }catch(error){
        // Stripe can race us between retrieve() and expire(). Re-read once so a
        // just-completed payment is fulfilled instead of being mistaken for an
        // abandoned checkout. Only rethrow while the session is still payable.
        session=await stripe.checkout.sessions.retrieve(id);
        if(String(session?.status||'').toLowerCase()==='open')throw error;
    }

    status=String(session?.status||'').toLowerCase();
    paymentStatus=String(session?.payment_status||'').toLowerCase();

    if(status==='expired'){
        await checkoutIntents.completeVerifiedProvider('stripe',session.id,'cancelled');
        return{terminal:true,cancelled:true,status,paymentStatus};
    }

    if(status==='complete'&&['paid','no_payment_required'].includes(paymentStatus)){
        await activateCheckoutSession(session);
        return{terminal:true,completed:true,internal:true,message:'Payment confirmed. Your access has been updated.',status,paymentStatus};
    }

    // A completed-but-unpaid Checkout Session can still settle asynchronously.
    // Keep the existing checkout lock in that case so a customer cannot pay twice.
    return{terminal:false,status,paymentStatus};
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
    return providerLifecycleState.isTerminal('stripe',status);
}
function effectiveSyncStatus(remoteStatus,statusOverride=null) {
    const remote=String(remoteStatus||'').toLowerCase(),override=String(statusOverride||'').toLowerCase();
    if(terminalStripeStatus(remote))return remoteStatus;
    if(override==='past_due'&&['active','trialing'].includes(remote))return remoteStatus;
    return statusOverride||remoteStatus;
}
function stripeObjectId(value){return typeof value==='string'?value:value?.id||null;}
async function serviceCreditInvoiceItem(stripe,invoiceId,reservationId){
    let startingAfter=null,pages=0;
    while(true){
        if(++pages>100)throw new Error(`Stripe renewal invoice ${invoiceId} has too many invoice items to verify safely.`);
        const items=await stripe.invoiceItems.list({invoice:String(invoiceId),limit:100,...(startingAfter?{starting_after:startingAfter}:{})});
        const found=(items?.data||[]).find(item=>String(item?.metadata?.captainfin_service_credit_reservation_id||'')===String(reservationId));
        if(found)return found;
        if(!items?.has_more||!(items?.data||[]).length)return null;
        startingAfter=items.data[items.data.length-1].id;
        if(!startingAfter)throw new Error(`Stripe renewal invoice ${invoiceId} pagination did not return a continuation ID.`);
    }
}
function validateServiceCreditInvoiceItem(item,reservation,invoiceId){
    const applied=Math.abs(Number(item?.amount||0));
    if(applied!==Number(reservation.amountMinor))throw new Error(`Stripe renewal service-credit amount mismatch for invoice ${invoiceId}: reserved ${reservation.amountMinor}, provider ${applied}.`);
    if(!item?.id)throw new Error(`Stripe renewal service-credit item for invoice ${invoiceId} has no provider reference.`);
    return item.id;
}
async function recoverServiceCreditProviderItem(stripe,invoiceId,reservation){
    const item=await serviceCreditInvoiceItem(stripe,invoiceId,reservation.id);
    if(!item)return null;
    const providerAdjustmentId=validateServiceCreditInvoiceItem(item,reservation,invoiceId);
    const saved=await renewalCredits.markStripeApplied({providerInvoiceId:invoiceId,providerAdjustmentId});
    return{reservation:saved||reservation,providerAdjustmentId};
}
async function applyServiceCreditToRenewalInvoice(invoice,stripe){
    if(!invoice?.id||String(invoice.billing_reason||'')!=='subscription_cycle')return{applied:false,reason:'not_subscription_cycle'};
    let live=await stripe.invoices.retrieve(invoice.id);
    if(String(live.status||'')!=='draft'){
        const existing=await renewalCredits.reservationForStripeInvoice(live.id);
        if(!existing||['consumed','released'].includes(existing.state))return{applied:false,reason:'invoice_not_draft'};
        const recovered=await recoverServiceCreditProviderItem(stripe,live.id,existing);
        if(recovered)return{applied:true,...recovered,existing:true,recovered:true};
        await renewalCredits.releaseStripeInvoice(live.id,'invoice_finalized_without_service_credit_adjustment');
        return{applied:false,reason:'invoice_finalized_without_adjustment'};
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
            const recovered=await recoverServiceCreditProviderItem(stripe,invoice.id,reservation);
            if(recovered)return{applied:true,...recovered,recovered:true};
            if(String(live.status||'')!=='draft'){
                await renewalCredits.releaseStripeInvoice(invoice.id,'invoice_finalized_without_service_credit_adjustment');
                return{applied:false,reason:'invoice_finalized_without_adjustment'};
            }
        }catch(recoveryError){
            throw recoveryError;
        }
        throw error;
    }
}
async function settlePaidServiceCreditInvoice(invoice,stripe){
    if(!invoice?.id)return null;
    const reservation=await renewalCredits.reservationForStripeInvoice(invoice.id);
    if(!reservation||reservation.state==='consumed'||reservation.state==='released')return reservation;
    let adjustmentId=reservation.providerAdjustmentId;
    if(!adjustmentId){
        const recovered=await recoverServiceCreditProviderItem(stripe,invoice.id,reservation);
        if(!recovered){
            await renewalCredits.releaseStripeInvoice(invoice.id,'paid_without_service_credit_adjustment');
            return{...reservation,state:'released'};
        }
        adjustmentId=recovered.providerAdjustmentId;
    }
    return renewalCredits.consumeStripeInvoice({providerInvoiceId:invoice.id,providerAdjustmentId:adjustmentId});
}
// Amount actually owed for the checkout before tax: line items minus discounts. Recurring Checkout carries the first
// invoice only, and the adjustment/discount coupons we create make this exact. Tax (if the Stripe account adds any) is
// not part of the frozen commercial contract, so it is excluded rather than rejected.
function sessionNetMinor(session){
    const subtotal=Number(session?.amount_subtotal),discount=Number(session?.total_details?.amount_discount||0);
    if(Number.isInteger(subtotal)&&subtotal>=0&&Number.isInteger(discount)&&discount>=0)return Math.max(0,subtotal-discount);
    const total=Number(session?.amount_total);
    return Number.isInteger(total)&&total>=0?total:null;
}
async function checkoutContract(session) {
    const customerId=session.metadata?.internal_customer_id,planId=session.metadata?.internal_plan_id;
    if(!customerId||!planId)throw new Error('Stripe Checkout session is missing internal metadata');
    const stripe=await getStripe();
    const verified=await stripe.checkout.sessions.retrieve(session.id,{expand:['line_items.data.price']});
    if(!['paid','no_payment_required'].includes(verified.payment_status))throw new Error('Stripe Checkout session is not paid');
    const price=verified.line_items?.data?.[0]?.price||null,priceId=price?.id||null;
    // The exact local intent that created this session; never inferred from customer/plan/mode.
    const intentId=String(verified.metadata?.internal_checkout_intent_id||session.metadata?.internal_checkout_intent_id||'').trim()||null;
    const recurring=verified.mode==='subscription';
    const contract=await checkoutIntents.verifiedProviderContract({provider:'stripe',providerCheckoutId:verified.id,scope:'customer',ownerId:customerId,planId,checkoutMode:verified.mode,providerMappingId:recurring?priceId:null,checkoutIntentId:intentId,amountMinor:recurring?sessionNetMinor(verified):verified.amount_total,currency:recurring?(verified.currency||price?.currency):verified.currency});
    return{session:verified,customerId,planId,priceId,...contract};
}
// Authoritative evidence that a recurring Stripe checkout both matches the frozen commercial contract and was actually
// paid (or is a legitimate zero-cost checkout). An active agreement alone is not proof of payment.
function verifyStripeRecurringSettlement({session,subscription,snapshot,storedProviderCustomerId=null}){
    const fail=message=>{const error=new Error(message);error.code='STRIPE_RECURRING_SETTLEMENT_UNVERIFIED';return error;};
    const subscriptionId=stripeObjectId(session.subscription);
    if(!subscription||!subscriptionId||subscription.id!==subscriptionId)throw fail('Stripe subscription does not belong to this Checkout session.');
    const sessionCustomer=stripeObjectId(session.customer),subscriptionCustomer=stripeObjectId(subscription.customer);
    if(!sessionCustomer||sessionCustomer!==subscriptionCustomer)throw fail('Stripe subscription customer does not match the Checkout session customer.');
    if(storedProviderCustomerId&&String(storedProviderCustomerId)!==String(subscriptionCustomer))throw fail('Stripe customer does not match the customer this account was checked out under.');
    const intentId=String(snapshot.checkoutIntentId||'');
    const metadataIntent=String(subscription.metadata?.internal_checkout_intent_id||'');
    if(metadataIntent&&intentId&&metadataIntent!==intentId)throw fail('Stripe subscription belongs to a different checkout intent.');
    const metadataCustomer=String(subscription.metadata?.internal_customer_id||'');
    if(metadataCustomer&&String(session.metadata?.internal_customer_id||'')&&metadataCustomer!==String(session.metadata.internal_customer_id))throw fail('Stripe subscription metadata customer does not match the Checkout session.');
    const items=subscription.items?.data||[];
    if(items.length!==1||Number(items[0].quantity||1)!==1)throw fail('Stripe subscription does not contain exactly the purchased plan item.');
    const price=items[0].price&&typeof items[0].price==='object'?items[0].price:null;
    if(snapshot.providerMappingId&&String(price?.id||'')!==String(snapshot.providerMappingId))throw fail('Stripe subscription price does not match the checkout contract.');
    if(price){
        if(Number.isInteger(price.unit_amount)&&Number.isInteger(Number(snapshot.priceMinor))&&price.unit_amount!==Number(snapshot.priceMinor))throw fail('Stripe recurring price amount does not match the checkout contract.');
        if(price.currency&&snapshot.currency&&String(price.currency).toUpperCase()!==String(snapshot.currency).toUpperCase())throw fail('Stripe recurring price currency does not match the checkout contract.');
        const frequency=mappingVerification.expectedFrequency({billing_interval:snapshot.billingInterval});
        if(frequency&&price.recurring){
            const count=Number(price.recurring.interval_count||1);
            if(price.recurring.interval!==frequency.interval||count!==frequency.count)throw fail('Stripe recurring billing frequency does not match the purchased plan.');
        }
    }
    const expectedMinor=Number(snapshot.discountedMinor??snapshot.priceMinor),net=sessionNetMinor(session);
    if(!Number.isInteger(expectedMinor)||expectedMinor<0||net!==expectedMinor)throw fail('Stripe Checkout amount does not match the checkout contract.');
    if(String(session.currency||'').toUpperCase()!==String(snapshot.currency||'').toUpperCase())throw fail('Stripe Checkout currency does not match the checkout contract.');
    const invoice=subscription.latest_invoice&&typeof subscription.latest_invoice==='object'?subscription.latest_invoice:null;
    if(session.payment_status==='paid'){
        if(expectedMinor<=0)throw fail('Stripe reports a payment for a checkout that should have cost nothing.');
        if(!invoice||invoice.status!=='paid'||invoice.billing_reason!=='subscription_create'||String(invoice.currency||'').toUpperCase()!==String(snapshot.currency||'').toUpperCase()||!Number.isInteger(invoice.amount_paid)||invoice.amount_paid<=0||invoice.amount_paid!==session.amount_total)throw fail('The first Stripe invoice is not paid for the checkout amount, so the agreement is not proof of payment.');
        if(!['active','trialing'].includes(String(subscription.status||'')))throw fail(`Stripe subscription is ${subscription.status||'unknown'}, not active.`);
        return{paymentVerified:true,zeroCost:false};
    }
    // no_payment_required: only a checkout the contract itself made free (promo or service credit covering the whole price).
    const legitimateZero=expectedMinor===0&&net===0&&(Number(snapshot.serviceCreditMinor||0)>0||Boolean(snapshot.discountCodeId));
    if(!legitimateZero)throw fail('Stripe reports no payment was required, but the checkout contract is not a zero-cost checkout.');
    if(invoice&&((Number.isInteger(invoice.amount_paid)&&invoice.amount_paid!==0)||(Number.isInteger(invoice.amount_due)&&invoice.amount_due!==0)))throw fail('Stripe zero-cost checkout carries a non-zero first invoice.');
    return{paymentVerified:false,zeroCost:true};
}
async function activateCheckoutSession(session) {
    if(!['paid','no_payment_required'].includes(session.payment_status))return null;
    const contract=await checkoutContract(session),verified=contract.session,customerId=contract.customerId,planId=contract.planId;
    const providerCustomerId=typeof verified.customer==='string'?verified.customer:verified.customer?.id;
    if(verified.mode==='subscription'){
        const subscriptionId=typeof verified.subscription==='string'?verified.subscription:verified.subscription?.id;if(!subscriptionId)throw new Error('Stripe Checkout subscription ID is missing');
        const stripe=await getStripe(),subscription=await stripe.subscriptions.retrieve(subscriptionId,{expand:['items.data.price','latest_invoice']}),period=subscriptionPeriod(subscription);
        const storedCustomer=await lifecycle.findPaymentCustomer(customerId,'stripe');
        const settlement=verifyStripeRecurringSettlement({session:verified,subscription,snapshot:contract.snapshot,storedProviderCustomerId:storedCustomer?.provider_customer_id||null});
        const activated=await lifecycle.activatePurchase({customerId,planId,provider:'stripe',providerCustomerId,providerSubscriptionId:subscription.id,providerStatus:subscription.status,periodStart:period.start,periodEnd:period.end,cancelAtPeriodEnd:Boolean(subscription.cancel_at_period_end),commercialSnapshot:contract.snapshot,providerPaymentVerified:settlement.paymentVerified});
        await checkoutIntents.completeVerifiedProvider('stripe',verified.id,'completed');
        if(activated?.status==='active')await require('./plan-change-resolution').resolveAwaitingCheckout({customerId,planId,provider:'stripe',providerSubscriptionId:subscription.id,providerMappingId:contract.snapshot.providerMappingId});
        return activated;
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
    const paymentIntent=charge?.payment_intent||null,paymentIntentId=typeof paymentIntent==='string'?paymentIntent:paymentIntent?.id||null;
    if(paymentIntentId){
        const pi=typeof paymentIntent==='object'?paymentIntent:await stripe.paymentIntents.retrieve(paymentIntentId);
        metadata={...(pi?.metadata||{}),...metadata};
    }
    const invoiceRef=charge?.invoice||null,invoiceId=typeof invoiceRef==='string'?invoiceRef:invoiceRef?.id||null;
    if(invoiceId){
        const invoice=typeof invoiceRef==='object'?invoiceRef:await stripe.invoices.retrieve(invoiceId);
        providerSubscriptionId=extractInvoiceSubscriptionId(invoice);
    }
    if(!providerSubscriptionId&&paymentIntentId)providerSubscriptionId=paymentIntentId;
    let identity=await incidents.identityFromMetadata(metadata);
    if(identity.scope==='unresolved'&&providerSubscriptionId)identity=await incidents.identityFromProviderSubscription('stripe',providerSubscriptionId);
    return{identity,providerSubscriptionId,metadata,paymentIntentId,invoiceId};
}
async function reverseReferralForDirectIdentity(identity,incidentResult,reason,options={}){if(identity?.scope!=='direct'||!identity.customerId||incidentResult?.extensionPaymentLoss)return null;return referrals.revisitRewardAfterAdversePayment({referredCustomerId:identity.customerId,incidentId:incidentResult?.incident?.id||null,reason,...options});}
async function recordStripeRefund(event,stripe,charge) {
    const ctx=await incidentContextForCharge(stripe,charge),amount=Number(charge?.amount||0),refunded=Number(charge?.amount_refunded||0),fullRefund=amount>0&&refunded>=amount,recorded=await incidents.record({provider:'stripe',eventId:event.id,caseId:charge?.id||ctx.paymentIntentId,kind:'refund',status:'recorded',identity:ctx.identity,providerSubscriptionId:ctx.providerSubscriptionId,amountMinor:refunded,currency:charge?.currency,metadata:{...ctx.metadata,chargeId:charge?.id||null,fullRefund,originalAmountMinor:amount}});
    const customerId=ctx.identity?.customerId||null,providerCustomerId=stripeObjectId(charge?.customer);
    for(const refund of charge?.refunds?.data||[]){
        if(!refund?.id||!['succeeded','pending'].includes(String(refund.status||'succeeded').toLowerCase()))continue;
        let bt=refund.balance_transaction||null;
        if(typeof bt==='string')bt=await stripe.balanceTransactions.retrieve(bt);
        const rawAmount=Number(bt?.amount),grossMinor=Number.isFinite(rawAmount)&&rawAmount<0?Math.round(rawAmount):-Math.abs(Number(refund.amount||0));
        if(!grossMinor)continue;
        const feeMinor=Number.isFinite(Number(bt?.fee))?Math.round(Number(bt.fee)):0;
        const netMinor=Number.isFinite(Number(bt?.net))?Math.round(Number(bt.net)):grossMinor-feeMinor;
        await financialState.recordTransaction({
            provider:'stripe',
            providerTransactionId:bt?.id||refund.id,
            transactionType:'refund',
            transactionStatus:String(bt?.status||refund.status||'succeeded'),
            occurredAt:new Date(Number(bt?.created||refund.created||Date.now()/1000)*1000),
            currency:String(bt?.currency||refund.currency||charge.currency||'').toUpperCase(),
            grossMinor,feeMinor,netMinor,providerCustomerId,
            providerReferenceId:refund.id,providerSourceId:charge?.id||null,customerId,
            metadata:{providerAuthoritative:true,feeDataAvailable:Boolean(bt?.id),stripeRefundWebhook:true,providerEventId:event.id,chargeId:charge?.id||null,paymentIntentId:ctx.paymentIntentId,invoiceId:ctx.invoiceId,fullRefund}
        });
    }
    await reverseReferralForDirectIdentity(ctx.identity,recorded,`stripe:refund:${event.id}`,{amountMinor:refunded,fullLoss:fullRefund});return recorded;
}
async function recordStripeDispute(event,stripe,dispute) {
    const charge=typeof dispute?.charge==='string'?await stripe.charges.retrieve(dispute.charge):dispute?.charge||null;
    const ctx=await incidentContextForCharge(stripe,charge||{}),won=String(dispute?.status||'').toLowerCase()==='won',lost=String(dispute?.status||'').toLowerCase()==='lost',recorded=await incidents.record({provider:'stripe',eventId:event.id,caseId:dispute?.id||charge?.id,kind:lost?'chargeback':'dispute',status:won?'won':lost?'lost':'open',identity:ctx.identity,providerSubscriptionId:ctx.providerSubscriptionId,amountMinor:dispute?.amount,currency:dispute?.currency,metadata:{...ctx.metadata,disputeId:dispute?.id||null,reason:dispute?.reason||null,stripeStatus:dispute?.status||null}});
    if(lost)await reverseReferralForDirectIdentity(ctx.identity,recorded,`stripe:chargeback:${event.id}`,{amountMinor:dispute?.amount,fullLoss:true});return recorded;
}

async function handleWebhookEvent(event) {
    const stripe=await getStripe(),object=event.data?.object;
    switch(event.type){
        case 'checkout.session.completed': await activateCheckoutSession(object); break;
        case 'checkout.session.async_payment_succeeded': await activateCheckoutSession(object); break;
        case 'checkout.session.async_payment_failed': if(object?.id)await checkoutIntents.completeVerifiedProvider('stripe',object.id,'failed'); break;
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
module.exports={enabled,operational,recoverUnattachedCheckout,createCheckout,resumeCheckout,abandonCheckout,createCustomerPortal,processWebhook,retryPaymentEvent,handleWebhookEvent,subscriptionPeriod,incidentContextForCharge,checkoutContract,sessionNetMinor,verifyStripeRecurringSettlement,activateCheckoutSession,confirmCheckout,recordStripeRefund,recordStripeDispute,reverseReferralForDirectIdentity,effectiveSyncStatus,terminalStripeStatus,applyServiceCreditToRenewalInvoice,settlePaidServiceCreditInvoice,serviceCreditInvoiceItem,validateServiceCreditInvoiceItem};
