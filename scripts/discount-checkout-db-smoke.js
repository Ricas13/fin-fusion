'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const intents=require('../src/payments/checkout-intents');
const discounts=require('../src/payments/discounts');
const zeroValue=require('../src/payments/zero-value-checkout');

const suffix=crypto.randomBytes(6).toString('hex');
function unique(label){return `${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`;}
async function customer(label){return(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[label,`${unique(label)}@example.invalid`])).rows[0];}
async function plan(label,priceMinor=1000){return(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`,[unique(label),label,priceMinor])).rows[0];}
function snapshotFor(p){return{kind:'direct_plan',planId:p.id,planPriceId:null,planCode:p.code,planName:p.name,priceMinor:Number(p.price_minor),currency:'GBP',billingInterval:'month',durationDays:30,streams:1,stremioHouseholdNetworkLimit:1,provider:'stripe',checkoutMode:'payment',providerMappingId:null,providerMappingRecordId:null,discountedMinor:Number(p.price_minor)};}
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

  const frozen={...snapshotFor(p),discountCodeId:discount.id,discountCode:discount.code,discountReservationId:reserved.reservation.id,grossDiscountedMinor:0,serviceCreditMinor:0,serviceCreditCurrency:null,discountedMinor:0};
  await query(`UPDATE billing_checkout_intents SET commercial_snapshot=$2::jsonb,updated_at=NOW() WHERE id=$1`,[intent.id,JSON.stringify(frozen)]);

  const sub=await zeroValue.activateFullyDiscountedPayment({customerId:owner.id,intentId:intent.id,nonce:intent.nonce,provider:'stripe'});
  assert(sub,'zero-value checkout did not create a subscription');
  assert.strictEqual(sub.source,'manual','zero-cash purchase must use the legitimate local subscription source');
  assert.strictEqual(sub.status,'active');
  assert.strictEqual(Number(sub.price_minor_snapshot),1000,'subscription must retain the undiscounted catalogue price snapshot');
  assert.strictEqual(sub.provider_subscription_id,null,'zero-cash local settlement must not invent a provider payment identity');

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

async function main(){
  await fixedCurrencyMismatchInvariant();
  await fullyDiscountedPaymentInvariant();
  console.log('discount checkout DB smoke: currency integrity and zero-cash settlement ok');
}

main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
