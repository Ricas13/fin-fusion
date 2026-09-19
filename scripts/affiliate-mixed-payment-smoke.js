'use strict';
const assert=require('assert');
const {query,getPool}=require('../src/db');
const reservations=require('../src/payments/service-credit-reservations');
const checkoutIntents=require('../src/payments/checkout-intents');
const lifecycle=require('../src/payments/lifecycle');
const affiliateCredits=require('../src/affiliate-credits');
const {encryptWithEnv}=require('../src/security/purpose-crypto');

// Fleet capacity fails closed for any jellyfin premium/free plan with no
// matching, enabled jellyfin_servers row (see plan-capacity.js's fleetPlan
// gate) -- without this, both checkout intents below are rejected as sold
// out before the affiliate-credit assertions this file exists for ever run.
async function ensurePremiumServer(suffix){
 const apiKey=encryptWithEnv(`test-${suffix}`,'JELLYFIN_ENCRYPTION_KEY','jf1');
 return (await query(`
   INSERT INTO jellyfin_servers(
     name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
     enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode
   )
   VALUES($1,$2,'premium','jellyfin','https://example.invalid','https://example.invalid',$3,
          TRUE,1,1000,'healthy',TRUE,TRUE,TRUE,'active')
   RETURNING id
 `,[`mixed-server-${suffix}`,`mixed-server-${suffix}`,apiKey])).rows[0].id;
}

async function main(){
 const suffix=Date.now().toString(36);
 await ensurePremiumServer(suffix);
 const user=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,'x','customer',TRUE) RETURNING id`,[`mixed-${suffix}`,`mixed-${suffix}@example.invalid`])).rows[0];
 const customer=(await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.id,`Mixed ${suffix}`,`mixed-${suffix}@example.invalid`])).rows[0];
 await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)`,[customer.id]);
 await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note) VALUES($1,'GBP',400,'adjustment','available',$2,'mixed smoke')`,[customer.id,`mixed-seed-${suffix}`]);
 const plan=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,'Mixed plan','jellyfin','direct','month',30,600,'GBP',100,TRUE,TRUE,1,'premium') RETURNING id`,[`mixed-plan-${suffix}`])).rows[0];
 const price=(await query(`SELECT id FROM plan_prices WHERE plan_id=$1 AND currency='GBP' LIMIT 1`,[plan.id])).rows[0];
 assert(price&&price.id,'plan-price compatibility trigger must create the default GBP price');

 const intent=await checkoutIntents.createIntent({
   scope:'customer',customerId:customer.id,planId:plan.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',
   commercialSnapshot:{kind:'direct_plan',planId:plan.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',priceMinor:600,discountedMinor:200,currency:'GBP'}
 });
 const reserved=await reservations.reserveForIntent({customerId:customer.id,checkoutIntentId:intent.id,currency:'GBP',maxAmountMinor:550,expiresAt:new Date(Date.now()+70*60*1000)});
 assert.equal(reserved.amountMinor,400,'mixed checkout should reserve available credit');
 assert.equal(await reservations.availableMinor(customer.id,'GBP'),0,'reserved credit must not be spendable twice');
 await checkoutIntents.consume({intentId:intent.id,nonce:intent.nonce,scope:'customer',provider:'stripe',ownerId:customer.id,state:'completed'});
 const spent=(await query(`SELECT amount_minor FROM affiliate_credit_ledger WHERE customer_id=$1 AND reference_id=$2`,[customer.id,`mixed-checkout:${intent.id}`])).rows[0];
 assert.equal(Number(spent.amount_minor),-400,'verified completion must consume exactly the reserved credit');
 assert.equal((await reservations.reservationForIntent(intent.id)).state,'applied');
 const closed=(await query(`SELECT state FROM billing_checkout_intents WHERE id=$1`,[intent.id])).rows[0];
 assert.equal(closed.state,'completed','real checkout completion must close the open intent');

 const second=await checkoutIntents.createIntent({
   scope:'customer',customerId:customer.id,planId:plan.id,planPriceId:price.id,provider:'paypal',checkoutMode:'payment',
   commercialSnapshot:{kind:'direct_plan',planId:plan.id,planPriceId:price.id,provider:'paypal',checkoutMode:'payment',priceMinor:600,discountedMinor:600,currency:'GBP'}
 });
 const none=await reservations.reserveForIntent({customerId:customer.id,checkoutIntentId:second.id,currency:'GBP',maxAmountMinor:550,expiresAt:new Date(Date.now()+55*60*1000)});
 assert.equal(none.amountMinor,0,'spent credit must not be reusable');
 await checkoutIntents.consume({intentId:second.id,nonce:second.nonce,scope:'customer',provider:'paypal',ownerId:customer.id,state:'cancelled'});

 // Late provider settlement after the service-credit reservation is no longer
 // financially backed must fail before local access commits.
 const lateUser=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,'x','customer',TRUE) RETURNING id`,[`mixed-late-${suffix}`,`mixed-late-${suffix}@example.invalid`])).rows[0];
 const lateCustomer=(await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[lateUser.id,`Mixed Late ${suffix}`,`mixed-late-${suffix}@example.invalid`])).rows[0];
 await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)`,[lateCustomer.id]);
 await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note) VALUES($1,'GBP',400,'adjustment','available',$2,'late mixed smoke')`,[lateCustomer.id,`mixed-late-seed-${suffix}`]);
 const lateIntent=await checkoutIntents.createIntent({
   scope:'customer',customerId:lateCustomer.id,planId:plan.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',
   commercialSnapshot:{kind:'direct_plan',planId:plan.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',priceMinor:600,discountedMinor:200,currency:'GBP',durationDays:30,planName:'Mixed plan',planCode:`mixed-plan-${suffix}`,serviceCreditMinor:400}
 });
 await reservations.reserveForIntent({customerId:lateCustomer.id,checkoutIntentId:lateIntent.id,currency:'GBP',maxAmountMinor:400,expiresAt:new Date(Date.now()+60*60*1000)});
 await query(`UPDATE affiliate_credit_checkout_reservations SET expires_at=NOW()-INTERVAL '1 minute' WHERE checkout_intent_id=$1`,[lateIntent.id]);
 await affiliateCredits.adminAdjustCredit({customerId:lateCustomer.id,currency:'GBP',amountMinor:-400,reason:'simulate credit spent after reservation expiry'});
 await assert.rejects(
   lifecycle.activatePurchase({
     customerId:lateCustomer.id,
     planId:plan.id,
     provider:'stripe',
     providerSubscriptionId:`pi_late_mixed_${suffix}`,
     providerStatus:'active',
     commercialSnapshot:{kind:'direct_plan',planId:plan.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',priceMinor:600,discountedMinor:200,currency:'GBP',durationDays:30,planName:'Mixed plan',planCode:`mixed-plan-${suffix}`,serviceCreditMinor:400,checkoutIntentId:lateIntent.id}
   }),
   /settled after its service-credit reservation was released or expired/i,
   'late provider cash must not activate full access when the promised service-credit portion is no longer available'
 );
 const leaked=await query(`SELECT id FROM subscriptions WHERE source='stripe' AND provider_subscription_id=$1`,[`pi_late_mixed_${suffix}`]);
 assert.equal(leaked.rowCount,0,'mixed-payment settlement failure must roll back entitlement activation atomically');
 const unpaidAccessIncident=(await query(`
   SELECT incident_status,metadata,provider_subscription_id
   FROM payment_incidents
   WHERE provider='stripe' AND provider_case_id=$1 AND incident_type='checkout_completion'
 `,[lateIntent.id])).rows[0];
 assert(unpaidAccessIncident,'late provider payment with unavailable service credit must have a durable paid-but-unfulfilled incident');
 assert.equal(unpaidAccessIncident.incident_status,'open','unfulfilled paid checkout remains open for operator recovery');
 assert.equal(unpaidAccessIncident.metadata.reason,'service_credit_unavailable_after_provider_settlement','operator must see the actual credit-shortfall reason');
 assert.equal(unpaidAccessIncident.metadata.paidButUnfulfilled,true,'checkout incident must identify real money taken without entitlement');

 console.log('affiliate mixed-payment smoke: ok');
}
main().then(()=>getPool().end()).catch(async e=>{console.error(e.stack||e);try{await getPool().end()}catch{}process.exit(1)});
