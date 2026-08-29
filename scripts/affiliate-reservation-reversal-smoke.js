'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const {query,getPool}=require('../src/db');
const referrals=require('../src/referrals');
const credits=require('../src/affiliate-credits');
const incidents=require('../src/payments/incidents');
const reservations=require('../src/payments/service-credit-reservations');
const checkoutIntents=require('../src/payments/checkout-intents');

const suffix=crypto.randomBytes(5).toString('hex');
const uniq=label=>`${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`;

function functionSlice(source,name,nextName){const start=source.indexOf(`async function ${name}`);assert(start>=0,`Missing ${name}`);const end=nextName?source.indexOf(`async function ${nextName}`,start+1):-1;return source.slice(start,end>start?end:source.length);}
function assertCheckoutLockOrder(){
  const source=fs.readFileSync(path.join(__dirname,'../src/payments/checkout-intents.js'),'utf8');
  for(const [name,next,needle] of [
    ['createIntent','attachProviderCheckout','UPDATE billing_checkout_intents'],
    ['consume','completeVerifiedProvider','FOR UPDATE'],
    ['completeVerifiedProvider','findProviderIntent','FOR UPDATE'],
    ['cancelForOwner',null,'UPDATE billing_checkout_intents']
  ]){
    const body=functionSlice(source,name,next),lock=body.indexOf('lockCheckoutOwner'),narrow=body.indexOf(needle);
    assert(lock>=0&&narrow>=0&&lock<narrow,`${name} must lock the customer before checkout-intent/reservation state`);
  }
}

async function setRate(){
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb)
    ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[
    JSON.stringify({enabled:true,rewardPercent:25,qualificationDelayDays:0,refundWindowDays:0})
  ]);
}
async function customer(label){return(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[label,`${uniq(label)}@example.invalid`])).rows[0];}
async function plan(label,priceMinor){return(await query(`INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
  VALUES($1,$2,'jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING *`,[uniq(label),label,priceMinor])).rows[0];}
async function rewardedAffiliate(label){
  const affiliate=await customer(`${label}-affiliate`);await credits.enroll(affiliate.id);
  const referred=await customer(`${label}-buyer`),paidPlan=await plan(`${label}-purchase`,10000);
  const code=(await query(`SELECT code FROM referral_codes WHERE customer_id=$1`,[affiliate.id])).rows[0].code;
  await referrals.attributeReferral(referred.id,code);
  const sub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,price_minor_snapshot,currency_snapshot,commercial_snapshot)
    VALUES($1,$2,'active','stripe',NOW()-INTERVAL '1 day',NOW()+INTERVAL '30 days',$3,10000,'GBP',$4::jsonb) RETURNING *`,[
      referred.id,paidPlan.id,`stripe-${uniq(label)}`,JSON.stringify({discountedMinor:10000})
    ])).rows[0];
  const reward=await referrals.rewardIfQualifying(referred.id);assert.equal(reward?.amountMinor,2500,`${label}: expected £25 reward`);
  const redemption=(await query(`SELECT * FROM referral_redemptions WHERE referred_customer_id=$1`,[referred.id])).rows[0];
  const grant=(await query(`SELECT * FROM affiliate_credit_ledger WHERE referral_redemption_id=$1 AND entry_type='earned'`,[redemption.id])).rows[0];
  return{affiliate,referred,sub,grant};
}
async function reserve(affiliate,label,amountMinor=1000){
  const target=await plan(`${label}-target`,2000),price=(await query(`SELECT id FROM plan_prices WHERE plan_id=$1 AND currency='GBP' LIMIT 1`,[target.id])).rows[0];
  const intent=await checkoutIntents.createIntent({scope:'customer',customerId:affiliate.id,planId:target.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',commercialSnapshot:{kind:'direct_plan',planId:target.id,planPriceId:price.id,provider:'stripe',checkoutMode:'payment',priceMinor:2000,discountedMinor:1000,currency:'GBP'}});
  const held=await reservations.reserveForIntent({customerId:affiliate.id,checkoutIntentId:intent.id,currency:'GBP',maxAmountMinor:amountMinor,expiresAt:new Date(Date.now()+70*60*1000)});
  assert.equal(held.amountMinor,amountMinor,`${label}: expected service-credit reservation`);return intent;
}
async function fullRefund(purchase,label){
  const recorded=await incidents.record({provider:'stripe',eventId:`evt-${uniq(label)}`,caseId:`case-${uniq(label)}`,kind:'refund',status:'recorded',identity:{scope:'direct',customerId:purchase.referred.id},providerSubscriptionId:purchase.sub.provider_subscription_id,amountMinor:10000,currency:'GBP',metadata:{originalAmountMinor:10000,fullRefund:true}});
  return recorded.incident;
}
async function reverse(purchase,incident,label){return referrals.revisitRewardAfterAdversePayment({referredCustomerId:purchase.referred.id,incidentId:incident.id,reason:`stripe:refund:${label}`});}
async function balance(customerId){return (await credits.balances(customerId)).find(row=>row.currency==='GBP')||{available_minor:0,recoverable_minor:0};}

async function main(){
  assertCheckoutLockOrder();
  await setRate();

  // Reservation cancelled: reversal waits while held, then removes the whole reward.
  const cancelled=await rewardedAffiliate('cancel'),cancelIntent=await reserve(cancelled.affiliate,'cancel'),cancelIncident=await fullRefund(cancelled,'cancel');
  await assert.rejects(()=>reverse(cancelled,cancelIncident,'cancel'),error=>error?.code==='AFFILIATE_CREDIT_RESERVATION_PENDING','Open reservation must defer affiliate reversal instead of consuming held credit');
  let cancelBal=await balance(cancelled.affiliate.id);assert.equal(cancelBal.available_minor,1500,'Held reservation should reduce spendable balance without creating debt');assert.equal(cancelBal.recoverable_minor,0);
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='reversed'`,[cancelled.affiliate.id])).rows[0].n),0,'Deferred reversal must not partially mutate accounting');
  await checkoutIntents.consume({intentId:cancelIntent.id,nonce:cancelIntent.nonce,scope:'customer',provider:'stripe',ownerId:cancelled.affiliate.id,state:'cancelled'});
  const cancelledReversal=await reverse(cancelled,cancelIncident,'cancel-retry');assert.equal(cancelledReversal.reversed,true);
  cancelBal=await balance(cancelled.affiliate.id);assert.equal(cancelBal.available_minor,0,'Released reservation must allow full unspent reversal');assert.equal(cancelBal.recoverable_minor,0,'Cancelled checkout delivered no service and must create no recovery');

  // Reservation completed: reversal waits; after completion the realized spend is
  // allocated to the reward and only that delivered value becomes recoverable.
  const completed=await rewardedAffiliate('complete'),completeIntent=await reserve(completed.affiliate,'complete'),completeIncident=await fullRefund(completed,'complete');
  await assert.rejects(()=>reverse(completed,completeIncident,'complete'),error=>error?.code==='AFFILIATE_CREDIT_RESERVATION_PENDING');
  await checkoutIntents.consume({intentId:completeIntent.id,nonce:completeIntent.nonce,scope:'customer',provider:'stripe',ownerId:completed.affiliate.id,state:'completed'});
  const debit=(await query(`SELECT * FROM affiliate_credit_ledger WHERE customer_id=$1 AND reference_id=$2`,[completed.affiliate.id,`mixed-checkout:${completeIntent.id}`])).rows[0];
  assert.equal(Number(debit.amount_minor),-1000,'Completed reservation must realize exactly the held service-credit spend');
  assert.equal(Number((await query(`SELECT COALESCE(SUM(amount_minor),0)::int n FROM affiliate_credit_allocations WHERE debit_ledger_id=$1 AND grant_ledger_id=$2`,[debit.id,completed.grant.id])).rows[0].n),1000,'Completed checkout debit must retain grant provenance');
  const completedReversal=await reverse(completed,completeIncident,'complete-retry');assert.equal(completedReversal.reversed,true);
  let completedBal=await balance(completed.affiliate.id);assert.equal(completedBal.available_minor,0,'Full refund after completed reservation must leave no spendable affiliate credit');assert.equal(completedBal.recoverable_minor,1000,'Only actually delivered invalid affiliate credit should become explicit recovery');
  const reversalMinor=Number((await query(`SELECT COALESCE(SUM(-amount_minor),0)::int n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='reversed' AND state<>'void'`,[completed.affiliate.id])).rows[0].n);assert.equal(reversalMinor,1500,'Unspent reward portion must be reversed exactly once');
  await reverse(completed,completeIncident,'complete-replay');completedBal=await balance(completed.affiliate.id);
  assert.equal(completedBal.recoverable_minor,1000,'Refund retry must not double recover already-delivered value');
  assert.equal(Number((await query(`SELECT COALESCE(SUM(-amount_minor),0)::int n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='reversed' AND state<>'void'`,[completed.affiliate.id])).rows[0].n),1500,'Refund retry must not double reverse unspent value');

  console.log('affiliate reservation/reversal smoke: open holds defer; cancel and completion converge without hidden debt');
}
main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
