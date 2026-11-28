'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const lifecycle=require('../src/payments/lifecycle-primitives');
const intents=require('../src/payments/checkout-intents');
const discounts=require('../src/payments/discounts');
const zeroValue=require('../src/payments/zero-value-checkout');
const {encryptWithEnv}=require('../src/security/purpose-crypto');

const suffix=crypto.randomBytes(6).toString('hex');
let mediaServer=null;
function unique(label){return `${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`;}
async function ensureMediaServer(){
  const apiKey=encryptWithEnv(`discount-${suffix}`,'JELLYFIN_ENCRYPTION_KEY','jf1');
  mediaServer=(await query(`
    INSERT INTO jellyfin_servers(
      name,slug,server_class,media_server_type,base_url,public_url,location,api_key_encrypted,
      enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode
    ) VALUES($1,$2,'premium','jellyfin','https://discount.example.invalid','https://discount.example.invalid',
      'Discount Test',$3,TRUE,1,1000,'healthy',TRUE,TRUE,TRUE,'active')
    RETURNING id,location
  `,[`Discount checkout ${suffix}`,unique('discount-server'),apiKey])).rows[0];
}
async function customer(label){return(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[label,`${unique(label)}@example.invalid`])).rows[0];}
async function plan(label,priceMinor=1000){
  const row=(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`,[unique(label),label,priceMinor])).rows[0];
  if(!mediaServer)throw new Error('Discount media server was not initialized');
  await query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)`,[row.id,mediaServer.id]);
  return row;
}
function snapshotFor(p){return{kind:'direct_plan',planId:p.id,planPriceId:null,planCode:p.code,planName:p.name,priceMinor:Number(p.price_minor),currency:'GBP',billingInterval:'month',durationDays:30,streams:1,stremioHouseholdNetworkLimit:1,provider:'stripe',checkoutMode:'payment',providerMappingId:null,providerMappingRecordId:null,discountedMinor:Number(p.price_minor),mediaLocation:'Discount Test'};}
async function expectCode(fn,code){let error=null;try{await fn();}catch(caught){error=caught;}assert(error,`Expected ${code} failure`);assert.strictEqual(error.code,code,`Expected ${code}, got ${error.code||error.message}`);return error;}

async function fixedCurrencyMismatchInvariant(){
  const owner=await customer('discount-currency');
  const p=await plan('Discount currency plan',1000);
  const code=unique('EURFIX').toUpperCase();
  await query(`INSERT INTO discount_codes(code,discount_type,fixed_off_minor,currency,max_redemptions,per_customer_limit,active) VALUES($1,'fixed',500,'EUR',5,1,TRUE)`,[code]);

  await expectCode(()=>discounts.validateForCheckout({code,planId:p.id,planCode:p.code,customerId:owner.id,currency:'GBP'}),'DISCOUNT_CURRENCY_MISMATCH');

  const intent=await intents.createIntent({scope:'customer',customerId:owner.id,planId:p.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:snapshotFor(p)});
  await expectCode(()=>discounts.reserveForIntent({code,planCode:p.code,customerId:owner.id,checkoutIntentId:intent.id,baseMinor:1000,currency:'GBP',ttlMinutes:30}),'DISCOUNT_CURRENCY_MISMATCH');
  const reservations=await query(`SELECT id FROM discount_checkout_reservations WHERE checkout_intent_id=$1`,[intent.id]);
  assert.strictEqual(reservations.rowCount,0,'currency mismatch must fail before a discount reservation is created');
  await intents.consume({intentId:intent.id,nonce:intent.nonce,state:'failed',scope:'customer',provider:'stripe',ownerId:owner.id});
}

async function fullyDiscountedPaymentInvariant(){
  const owner=await customer('discount-zero');
  const p=await plan('Fully discounted plan',1000);
  const code=unique('FREE100').toUpperCase();
  const discount=(await query(`INSERT INTO discount_codes(code,discount_type,percent_off,max_redemptions,per_customer_limit,active) VALUES($1,'percent',100,1,1,TRUE) RETURNING *`,[code])).rows[0];
  const intent=await intents.createIntent({scope:'customer',customerId:owner.id,planId:p.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:snapshotFor(p)});
  const reserved=await discounts.reserveForIntent({code,planCode:p.code,customerId:owner.id,checkoutIntentId:intent.id,baseMinor:1000,currency:'GBP',ttlMinutes:30});
  assert.strictEqual(Number(reserved.discountedMinor),0,'100% promo must freeze a zero provider amount');
  assert.strictEqual(Number(reserved.reservation.amount_applied_minor),1000,'100% promo must freeze the whole catalogue price');

  const frozen={...(intent.commercial_snapshot||snapshotFor(p)),discountCodeId:discount.id,discountCode:discount.code,discountReservationId:reserved.reservation.id,grossDiscountedMinor:0,serviceCreditMinor:0,serviceCreditCurrency:null,discountedMinor:0};
  await query(`UPDATE billing_checkout_intents SET commercial_snapshot=$2::jsonb,updated_at=NOW() WHERE id=$1`,[intent.id,JSON.stringify(frozen)]);

  const sub=await zeroValue.activateFullyDiscountedPayment({customerId:owner.id,intentId:intent.id,nonce:intent.nonce,provider:'stripe'});
  assert(sub,'zero-value checkout did not create a subscription');
  assert.strictEqual(sub.source,'manual','zero-cash purchase must use the legitimate local subscription source');
  assert.strictEqual(sub.status,'active');
  assert.strictEqual(Number(sub.price_minor_snapshot),1000,'subscription must retain the undiscounted catalogue price snapshot');
  assert.strictEqual(sub.provider_subscription_id,null,'zero-cash local settlement must not invent a provider payment identity');
  assert.strictEqual(String(sub.media_server_id),String(intent.media_server_id),'zero-cash subscription must retain the exact physical server reserved by checkout');
  assert.strictEqual(sub.media_location_snapshot,'Discount Test','zero-cash subscription must retain the selected media location');

  const settledIntent=(await query(`SELECT state,provider_checkout_id FROM billing_checkout_intents WHERE id=$1`,[intent.id])).rows[0];
  assert.strictEqual(settledIntent.state,'completed','zero-cash checkout intent was not completed');
  assert.strictEqual(settledIntent.provider_checkout_id,null,'zero-cash checkout must complete before any provider checkout is attached');
  const reservation=(await query(`SELECT state,consumed_at FROM discount_checkout_reservations WHERE id=$1`,[reserved.reservation.id])).rows[0];
  assert.strictEqual(reservation.state,'consumed','fully covering promo reservation was not consumed atomically');
  assert(reservation.consumed_at,'fully covering promo reservation has no consumption timestamp');
  const redemption=(await query(`SELECT * FROM discount_redemptions WHERE subscription_id=$1`,[sub.id])).rows[0];
  assert(redemption,'fully covering promo did not create a durable redemption');
  assert.strictEqual(String(redemption.discount_code_id),String(discount.id));
  assert.strictEqual(Number(redemption.amount_applied_minor),1000,'fully covering promo redemption must equal the frozen discount amount');
  const count=Number((await query(`SELECT redemption_count FROM discount_codes WHERE id=$1`,[discount.id])).rows[0].redemption_count);
  assert.strictEqual(count,1,'fully covering promo must consume exactly one redemption');
}

async function editableCustomerLimitInvariant(){
  const owner=await customer('discount-edit-limit');
  const p=await plan('Editable limit plan',1000);
  const code=unique('EDITLIMIT').toUpperCase();
  const admin=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,$3,'admin',TRUE) RETURNING id`,[unique('discount-admin'),`${unique('discount-admin')}@example.invalid`,await require('bcryptjs').hash(unique('password'),10)])).rows[0];
  const d=(await query(`INSERT INTO discount_codes(code,discount_type,percent_off,max_redemptions,per_customer_limit,active) VALUES($1,'percent',25,100,1,TRUE) RETURNING *`,[code])).rows[0];
  await query(`INSERT INTO discount_redemptions(discount_code_id,customer_id,amount_applied_minor) VALUES($1,$2,250)`,[d.id,owner.id]);
  await query(`UPDATE discount_codes SET redemption_count=1 WHERE id=$1`,[d.id]);
  const input={discountCodeId:d.id,actorUserId:admin.id};
  await assert.rejects(()=>discounts.validateForCheckout({code,planId:p.id,planCode:p.code,customerId:owner.id,currency:'GBP'}),/already used/);
  for(const limit of ['1.5','50foo','0','1001',[],null]) await assert.rejects(()=>discounts.updatePerCustomerLimit({...input,limit}),/between 1 and 1000/);
  const updated=await discounts.updatePerCustomerLimit({...input,limit:'50'});
  assert.strictEqual(updated.per_customer_limit,50);
  assert.strictEqual(updated.max_redemptions,100);
  assert.strictEqual(updated.redemption_count,1);
  assert.strictEqual(updated.percent_off,25);
  await discounts.validateForCheckout({code,planId:p.id,planCode:p.code,customerId:owner.id,currency:'GBP'});
  const intent=await intents.createIntent({scope:'customer',customerId:owner.id,planId:p.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:snapshotFor(p)});
  const reservation=await discounts.reserveForIntent({code,planCode:p.code,customerId:owner.id,checkoutIntentId:intent.id,baseMinor:1000,currency:'GBP',ttlMinutes:30});
  await assert.rejects(()=>discounts.updatePerCustomerLimit({...input,limit:1}),/existing redemptions and active reservations/);
  assert.strictEqual((await discounts.updatePerCustomerLimit({...input,limit:2})).per_customer_limit,2);
  assert.strictEqual((await query('SELECT state FROM discount_checkout_reservations WHERE id=$1',[reservation.reservation.id])).rows[0].state,'reserved');
  await discounts.updatePerCustomerLimit({...input,limit:2});
  const audits=(await query(`SELECT metadata,actor_user_id FROM audit_log WHERE entity_id=$1 AND action='admin.discount.limit.update' ORDER BY id`,[d.id])).rows;
  assert.deepStrictEqual(audits.map(a=>[a.metadata.previousLimit,a.metadata.newLimit]),[[1,50],[50,2]]);
  assert(audits.every(a=>a.actor_user_id===admin.id));
  await intents.consume({intentId:intent.id,nonce:intent.nonce,state:'failed',scope:'customer',provider:'stripe',ownerId:owner.id});
}

async function extensionPromoInvariant(){
  const owner=await customer('discount-extension');
  const p=await plan('Discount extension plan',1000);
  const sub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,provider_subscription_id,starts_at,current_period_end,service_type_snapshot,billing_interval_snapshot,duration_days_snapshot)
    VALUES($1,$2,'active','stripe','subscription',$3,NOW()-INTERVAL '1 day','2030-01-31T00:00:00Z','jellyfin','month',30) RETURNING *`,[owner.id,p.id,`sub_${unique('base')}`])).rows[0];
  const promo=(await query(`INSERT INTO discount_codes(code,discount_type,percent_off,max_redemptions,per_customer_limit,active) VALUES($1,'percent',25,4,4,TRUE) RETURNING *`,[unique('EXT25').toUpperCase()])).rows[0];
  const free=(await query(`INSERT INTO discount_codes(code,discount_type,percent_off,max_redemptions,per_customer_limit,active) VALUES($1,'percent',100,1,1,TRUE) RETURNING *`,[unique('EXT100').toUpperCase()])).rows[0];
  await query('INSERT INTO discount_redemptions(discount_code_id,customer_id,subscription_id,amount_applied_minor) VALUES($1,$2,$3,250)',[promo.id,owner.id,sub.id]);
  await query('UPDATE discount_codes SET redemption_count=1 WHERE id=$1',[promo.id]);
  async function prepare(code,provider){
    const snapshot={...snapshotFor(p),kind:'subscription_extension',extensionSubscriptionId:sub.id,accessVariantKind:'streams',accessQuantity:1,mediaLocation:null,provider};
    const intent=await intents.createIntent({scope:'customer',customerId:owner.id,planId:p.id,provider,checkoutMode:'payment',commercialSnapshot:snapshot});
    const reservation=await discounts.reserveForIntent({code:code.code,planCode:p.code,customerId:owner.id,checkoutIntentId:intent.id,baseMinor:1000,currency:'GBP'});
    const frozen={...intent.commercial_snapshot,discountCodeId:code.id,discountCode:code.code,discountReservationId:reservation.reservation.id,grossDiscountedMinor:reservation.discountedMinor,discountedMinor:reservation.discountedMinor,serviceCreditMinor:0};
    await query('UPDATE billing_checkout_intents SET commercial_snapshot=$2::jsonb WHERE id=$1',[intent.id,JSON.stringify(frozen)]);
    return {intent,reservation};
  }
  for(const provider of ['stripe','paypal','plisio']){
    const {intent,reservation}=await prepare(promo,provider);
    assert.strictEqual(reservation.discountedMinor,750);
    const paymentId=unique(provider==='stripe'?'pi':'capture');
    const checkoutId=unique('checkout');
    await intents.attachProviderCheckout(intent.id,checkoutId);
    const verified=await intents.verifiedProviderContract({provider,providerCheckoutId:checkoutId,ownerId:owner.id,planId:p.id,checkoutMode:'payment',amountMinor:750,currency:'GBP'});
    await intents.completeVerifiedProvider(provider,checkoutId,'completed');
    const activate=()=>lifecycle.activatePurchase({customerId:owner.id,planId:p.id,provider,providerSubscriptionId:paymentId,providerStatus:provider==='plisio'?'completed':'active',commercialSnapshot:verified.snapshot});
    await activate(); await activate();
    const ledger=(await query('SELECT * FROM subscription_access_extensions WHERE checkout_intent_id=$1',[intent.id])).rows;
    assert.strictEqual(ledger.length,1);
    const redemptions=(await query('SELECT * FROM discount_redemptions WHERE access_extension_id=$1',[ledger[0].id])).rows;
    assert.strictEqual(redemptions.length,1);
    assert.strictEqual(redemptions[0].subscription_id,null);
    assert.strictEqual(redemptions[0].amount_applied_minor,250);
    assert.strictEqual(redemptions[0].discount_code_id,promo.id);
    assert.strictEqual((await query('SELECT state FROM discount_checkout_reservations WHERE id=$1',[reservation.reservation.id])).rows[0].state,'consumed');
  }
  assert.strictEqual((await query('SELECT redemption_count FROM discount_codes WHERE id=$1',[promo.id])).rows[0].redemption_count,4);
  assert.strictEqual((await query('SELECT COUNT(*)::int n FROM discount_redemptions WHERE subscription_id=$1',[sub.id])).rows[0].n,1);
  await assert.rejects(()=>discounts.validateForCheckout({code:promo.code,planId:p.id,planCode:p.code,customerId:owner.id,currency:'GBP'}),/redemption limit/);
  const {intent,reservation}=await prepare(free,'plisio');
  await zeroValue.activateFullyDiscountedPayment({customerId:owner.id,intentId:intent.id,nonce:intent.nonce,provider:'plisio'});
  const all=(await query('SELECT purchased_days FROM subscription_access_extensions WHERE subscription_id=$1 ORDER BY created_at,id',[sub.id])).rows;
  assert.strictEqual(all.length,4);
  assert.deepStrictEqual(all.map(e=>e.purchased_days),[28,28,31,30],'full calendar terms irrespective of promo');
  assert.strictEqual((await query('SELECT redemption_count FROM discount_codes WHERE id=$1',[free.id])).rows[0].redemption_count,1);
  assert.strictEqual((await query('SELECT state FROM discount_checkout_reservations WHERE id=$1',[reservation.reservation.id])).rows[0].state,'consumed');
  const parent=(await query('SELECT * FROM subscriptions WHERE id=$1',[sub.id])).rows[0];
  assert.strictEqual(parent.service_extension_days,117);
  assert.strictEqual(parent.provider_subscription_id,sub.provider_subscription_id);
  assert.strictEqual(new Date(parent.current_period_end).toISOString(),new Date(sub.current_period_end).toISOString());
  assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1',[owner.id])).rows[0].n,1);
}

async function main(){
  await ensureMediaServer();
  await fixedCurrencyMismatchInvariant();
  await fullyDiscountedPaymentInvariant();
  await editableCustomerLimitInvariant();
  await extensionPromoInvariant();
  console.log('discount checkout DB smoke: currency integrity and zero-cash settlement ok');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
