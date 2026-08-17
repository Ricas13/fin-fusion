from pathlib import Path
import re


def replace_once(path, old, new):
    p=Path(path); s=p.read_text()
    if old not in s:
        raise SystemExit(f'missing expected text in {path}: {old[:120]!r}')
    p.write_text(s.replace(old,new,1))

# Checkout intents settle service-credit reservations alongside discount reservations.
replace_once('src/payments/checkout-intents.js',
"const commerce = require('./commerce-control');",
"const commerce = require('./commerce-control');\nconst serviceCreditReservations = require('./service-credit-reservations');")
replace_once('src/payments/checkout-intents.js',
"async function settleReservation(client,intentId,state){if(!intentId)return;const reservationState=state==='completed'?'consumed':state==='expired'?'expired':'released';await client.query(`UPDATE discount_checkout_reservations SET state=$2,consumed_at=CASE WHEN $2='consumed' THEN NOW() ELSE consumed_at END,released_at=CASE WHEN $2='released' THEN NOW() ELSE released_at END,updated_at=NOW() WHERE checkout_intent_id=$1 AND state='reserved'`,[intentId,reservationState]);}",
"async function settleReservation(client,intentId,state){if(!intentId)return;const reservationState=state==='completed'?'consumed':state==='expired'?'expired':'released';await client.query(`UPDATE discount_checkout_reservations SET state=$2,consumed_at=CASE WHEN $2='consumed' THEN NOW() ELSE consumed_at END,released_at=CASE WHEN $2='released' THEN NOW() ELSE released_at END,updated_at=NOW() WHERE checkout_intent_id=$1 AND state='reserved'`,[intentId,reservationState]);await serviceCreditReservations.settle(client,intentId,state);}")

# Affiliate balance is spendable ledger balance minus currently-live mixed checkout reservations.
p=Path('src/affiliate-credits.js'); s=p.read_text()
s=s.replace("const planPricing=require('./payments/plan-pricing');","const planPricing=require('./payments/plan-pricing');\nconst serviceCreditReservations=require('./payments/service-credit-reservations');",1)
s=re.sub(r"async function balances\(customerId\)\{.*?\n\}\n\nasync function matureDueCredits",'''async function balances(customerId){
  const r=await query(`WITH currencies AS (
      SELECT currency FROM affiliate_credit_ledger WHERE customer_id=$1
      UNION SELECT currency FROM affiliate_credit_checkout_reservations WHERE customer_id=$1
    ) SELECT c.currency,
      GREATEST(0,COALESCE((SELECT SUM(l.amount_minor) FROM affiliate_credit_ledger l WHERE l.customer_id=$1 AND l.currency=c.currency AND l.state='available'),0)-COALESCE((SELECT SUM(r.amount_minor) FROM affiliate_credit_checkout_reservations r WHERE r.customer_id=$1 AND r.currency=c.currency AND r.state='reserved' AND r.expires_at>NOW()),0))::int AS available_minor,
      COALESCE((SELECT SUM(l.amount_minor) FROM affiliate_credit_ledger l WHERE l.customer_id=$1 AND l.currency=c.currency AND l.state='pending'),0)::int AS pending_minor
    FROM currencies c ORDER BY c.currency`,[customerId]);
  return r.rows.map(row=>({...row,available_minor:Number(row.available_minor||0),pending_minor:Number(row.pending_minor||0),total_minor:Number(row.available_minor||0)+Number(row.pending_minor||0)}));
}

async function matureDueCredits''',s,count=1,flags=re.S)
s=s.replace("const current=await client.query(`SELECT COALESCE(SUM(amount_minor),0)::int balance FROM affiliate_credit_ledger WHERE customer_id=$1 AND currency=$2 AND state='available'`,[row.customer_id,row.currency]);\n    const reversible=Math.min(Number(row.amount_minor),Math.max(0,Number(current.rows[0]?.balance||0)));","const current=await serviceCreditReservations.availableMinorForClient(client,row.customer_id,row.currency);\n    const reversible=Math.min(Number(row.amount_minor),Math.max(0,Number(current||0)));",1)
s=s.replace("const bal=(await client.query(`SELECT COALESCE(SUM(amount_minor),0)::int amount FROM affiliate_credit_ledger WHERE customer_id=$1 AND currency=$2 AND state='available'`,[customerId,wanted])).rows[0];\n    const available=Number(bal?.amount||0);","const available=await serviceCreditReservations.availableMinorForClient(client,customerId,wanted);",1)
p.write_text(s)

# Flexible checkout: reserve affiliate credit and pass only the remainder to the provider.
p=Path('src/platform/flexible-checkout.js'); s=p.read_text()
s=s.replace("const commerce=require('../payments/commerce-control');","const commerce=require('../payments/commerce-control');\nconst serviceCreditReservations=require('../payments/service-credit-reservations');\nconst {query}=require('../db');",1)
start=s.index('async function begin(req,res,provider)')
end=s.index('async function finish(req,res,provider)',start)
new_begin=r'''async function begin(req,res,provider){
 const choice=await chooseOrResolve(req,res,provider);if(!choice||res.headersSent)return null;
 const wantsCredit=['on','true','1','yes'].includes(String(req.body.applyServiceCredit||'').toLowerCase());
 if(wantsCredit&&provider==='paypal'&&choice.mode==='subscription')throw new Error('Service credit cannot be combined with a recurring PayPal subscription. Use Stripe, a one-time PayPal option, or full service credit.');
 if(wantsCredit){const live=await query(`SELECT 1 FROM effective_customer_entitlements WHERE customer_id=$1 LIMIT 1`,[req.session.customerId]);if(live.rowCount)throw new Error('Mixed service-credit checkout is for activating a new plan. End the current service before applying credit to a new provider checkout.');}
 if(choice.mode==='subscription'&&!wantsCredit){const changed=await planChange.requestChange({customerId:req.session.customerId,targetPlanCode:choice.planCode,targetCurrency:choice.currency,timing:req.body.changeTiming||'auto',actorUserId:req.session.customerUserId});if(changed.handled)return{internal:true,message:changed.message}}
 const intent=await intents.createIntent({scope:'customer',customerId:req.session.customerId,planId:choice.plan.id,planPriceId:choice.plan.plan_price_id,provider,checkoutMode:choice.mode,ttlMinutes:60,commercialSnapshot:commercialSnapshot(choice,provider)});
 try{
   let reservation=null;if(req.body.discountCode)reservation=await discounts.reserveForIntent({code:req.body.discountCode,planCode:choice.planCode,customerId:req.session.customerId,checkoutIntentId:intent.id,baseMinor:Number(choice.plan.price_minor||0)});
   let snapshot=commercialSnapshot(choice,provider,reservation),grossDue=Number(snapshot.discountedMinor??snapshot.priceMinor||0),serviceCreditMinor=0;
   if(wantsCredit&&grossDue>50){const credit=await serviceCreditReservations.reserveForIntent({customerId:req.session.customerId,checkoutIntentId:intent.id,currency:choice.currency,maxAmountMinor:grossDue-50,expiresAt:new Date(Date.now()+(provider==='paypal'?7*60*60*1000:70*60*1000))});serviceCreditMinor=Number(credit.amountMinor||0);}
   const providerDue=Math.max(0,grossDue-serviceCreditMinor);snapshot={...snapshot,grossDiscountedMinor:grossDue,serviceCreditMinor,serviceCreditCurrency:serviceCreditMinor?choice.currency:null,discountedMinor:providerDue};
   const updated=await query(`UPDATE billing_checkout_intents SET commercial_snapshot=$2::jsonb,updated_at=NOW() WHERE id=$1 RETURNING commercial_snapshot,expires_at`,[intent.id,JSON.stringify(snapshot)]);intent.commercial_snapshot=updated.rows[0]?.commercial_snapshot||snapshot;intent.expires_at=updated.rows[0]?.expires_at||intent.expires_at;
   if(provider==='stripe'){const portal=await customers.getCustomerPortal(req.session.customerId);const checkout=await stripe.createCheckout({customerId:req.session.customerId,planCode:choice.planCode,checkoutMode:choice.mode,email:portal?.customer?.login_email||portal?.customer?.email,discountCode:req.body.discountCode||null,successUrl:await stateUrl(req,'/account?message=Payment%20received.%20Provider%20confirmation%20is%20being%20processed.',intent),cancelUrl:await stateUrl(req,'/account/checkout/cancel',intent),idempotencyKey:intent.id,commercialSnapshot:intent.commercial_snapshot,resolvedPlan:choice.plan,finalAmountMinor:providerDue,checkoutExpiresAt:intent.expires_at});await intents.attachProviderCheckout(intent.id,checkout.id);return checkout}
   const checkout=await paypal.createCheckout({customerId:req.session.customerId,planCode:choice.planCode,checkoutMode:choice.mode,discountCode:req.body.discountCode||null,returnUrl:await stateUrl(req,'/account/paypal/return',intent),cancelUrl:await stateUrl(req,'/account/checkout/cancel',intent),idempotencyKey:intent.id,checkoutIntentId:intent.id,commercialSnapshot:intent.commercial_snapshot,resolvedPlan:choice.plan,finalAmountMinor:providerDue});await intents.attachProviderCheckout(intent.id,checkout.id);return checkout
 }catch(error){await intents.consume({intentId:intent.id,nonce:intent.nonce,state:'failed',scope:'customer',provider,ownerId:req.session.customerId}).catch(()=>{});throw error}
}
'''
s=s[:start]+new_begin+s[end:]
p.write_text(s)

# Stripe: turn the combined code+credit reduction into one duration-once coupon, preserving the mapped price.
p=Path('src/payments/stripe.js'); s=p.read_text(); start=s.index('async function createCheckout('); end=s.index('async function createCustomerPortal',start)
new_stripe=r'''async function createCheckout({customerId,planCode,email,successUrl,cancelUrl,discountCode=null,checkoutMode=null,idempotencyKey=null,resolvedPlan=null,currency=null,finalAmountMinor=null,checkoutExpiresAt=null,commercialSnapshot=null}) {
    const plan=resolvedPlan||await providerPricing.getProviderPlan(planCode,'stripe',checkoutMode,currency);if(!plan)throw new Error('This plan is not configured for the selected Stripe payment type and currency');
    const stripe=await getStripe(),stripeCustomerId=await ensureStripeCustomer(customerId,email),mode=plan.checkout_mode==='subscription'?'subscription':'payment',baseMinor=Number(plan.price_minor||0),finalMinor=finalAmountMinor==null?null:Number(finalAmountMinor);
    if(finalMinor!=null&&(!Number.isInteger(finalMinor)||finalMinor<50||finalMinor>baseMinor))throw new Error('Adjusted Stripe checkout amount is invalid.');
    const metadata={internal_customer_id:customerId,internal_plan_id:plan.id,internal_plan_code:plan.code,...(plan.plan_price_id?{internal_plan_price_id:String(plan.plan_price_id)}:{}),...(plan.provider_mapping_id?{internal_provider_mapping_id:String(plan.provider_mapping_id)}:{}),...(idempotencyKey?{internal_checkout_intent_id:String(idempotencyKey)}:{})};
    const params={mode,customer:stripeCustomerId,line_items:[{price:plan.external_id,quantity:1}],success_url:successUrl,cancel_url:cancelUrl,metadata,integration_identifier:randomIntegrationIdentifier()};
    if(finalMinor!=null&&finalMinor<baseMinor){const coupon=await stripe.coupons.create({duration:'once',name:'CAPTAiNFiN checkout adjustment',amount_off:baseMinor-finalMinor,currency:String(plan.currency||'GBP').toLowerCase()});params.discounts=[{coupon:coupon.id}];if(commercialSnapshot?.discountCodeId)metadata.internal_discount_code_id=String(commercialSnapshot.discountCodeId);}
    else if(discountCode){const discount=await discounts.validateForCheckout({code:discountCode,planId:plan.id,planCode,customerId});if(discount.discount_type==='fixed'&&discount.currency&&String(discount.currency).toUpperCase()!==String(plan.currency).toUpperCase())throw new Error("That discount code's currency does not match this plan");const couponId=await ensureStripeCoupon(discount,plan);params.discounts=[{coupon:couponId}];metadata.internal_discount_code_id=discount.id;}
    if(checkoutExpiresAt){const epoch=Math.floor(new Date(checkoutExpiresAt).getTime()/1000),now=Math.floor(Date.now()/1000);if(Number.isFinite(epoch)&&epoch>=now+30*60&&epoch<=now+24*60*60)params.expires_at=epoch;}
    if(mode==='subscription')params.subscription_data={metadata};else params.payment_intent_data={metadata};
    const session=idempotencyKey?await stripe.checkout.sessions.create(params,{idempotencyKey:`checkout-${String(idempotencyKey)}`}):await stripe.checkout.sessions.create(params);return{id:session.id,url:session.url,mode};
}
'''
s=s[:start]+new_stripe+s[end:]; p.write_text(s)

# PayPal: mixed credit is safe for Orders; recurring PayPal plans stay unchanged.
p=Path('src/payments/paypal.js'); s=p.read_text(); start=s.index('async function createCheckout('); end=s.index('function paypalMinor',start)
new_paypal=r'''async function createCheckout({customerId,planCode,returnUrl,cancelUrl,discountCode=null,checkoutMode=null,idempotencyKey=null,resolvedPlan=null,currency=null,finalAmountMinor=null,commercialSnapshot=null}){const plan=resolvedPlan||await providerPricing.getProviderPlan(planCode,'paypal',checkoutMode,currency);if(!plan)throw new Error('This plan is not configured for the selected PayPal payment type and currency');const providerRequestId=idempotencyKey?String(idempotencyKey):crypto.randomUUID();await runtimeSettings.ensureLoaded().catch(()=>{});const brandName=runtimeSettings.siteName(),baseMinor=Number(plan.price_minor||0),finalMinor=finalAmountMinor==null?null:Number(finalAmountMinor);if(finalMinor!=null&&(!Number.isInteger(finalMinor)||finalMinor<1||finalMinor>baseMinor))throw new Error('Adjusted PayPal checkout amount is invalid.');if(plan.checkout_mode==='subscription'){if(!plan.external_id)throw new Error('This PayPal recurring option has no Billing Plan ID');if(finalMinor!=null&&finalMinor!==baseMinor)throw new Error('Service credit cannot be combined with a recurring PayPal subscription. Use Stripe, a one-time PayPal option, or full service credit.');if(discountCode)throw new Error('Discount codes are not supported for PayPal subscriptions yet. Use Stripe or a one-time PayPal payment.');const subscription=await api('/v1/billing/subscriptions',{method:'POST',requestId:providerRequestId,body:{plan_id:plan.external_id,custom_id:customId(customerId,plan.id),application_context:{brand_name:brandName,shipping_preference:'NO_SHIPPING',user_action:'SUBSCRIBE_NOW',return_url:returnUrl,cancel_url:cancelUrl}}}),url=approvalUrl(subscription);if(!url)throw new Error('PayPal did not return a subscription approval URL');return{id:subscription.id,url,mode:'subscription'};}let amountMinor=finalMinor!=null?finalMinor:baseMinor,discount=null,discountId=commercialSnapshot?.discountCodeId||null;if(finalMinor==null&&discountCode){discount=await discounts.validateForCheckout({code:discountCode,planId:plan.id,planCode,customerId});if(discount.discount_type==='fixed'&&discount.currency&&String(discount.currency).toUpperCase()!==String(plan.currency).toUpperCase())throw new Error("That discount code's currency does not match this plan");amountMinor=discounts.computeDiscountedMinor(amountMinor,discount);discountId=discount.id;}const value=(amountMinor/100).toFixed(2),order=await api('/v2/checkout/orders',{method:'POST',requestId:providerRequestId,body:{intent:'CAPTURE',purchase_units:[{custom_id:customId(customerId,plan.id,discountId),description:plan.name,amount:{currency_code:String(plan.currency).toUpperCase(),value}}],payment_source:{paypal:{experience_context:{brand_name:brandName,shipping_preference:'NO_SHIPPING',user_action:'PAY_NOW',return_url:returnUrl,cancel_url:cancelUrl}}}}}),url=approvalUrl(order);if(!url)throw new Error('PayPal did not return an order approval URL');return{id:order.id,url,mode:'payment'};}
'''
s=s[:start]+new_paypal+s[end:]; p.write_text(s)

print('affiliate mixed-payment integration patch applied')
