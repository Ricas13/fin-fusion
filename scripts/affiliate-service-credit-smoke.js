'use strict';

const assert=require('assert');
const {query,getPool}=require('../src/db');
const provisioning=require('../src/jellyfin/resilient-provisioning');
// This smoke validates commercial/account state only; Jellyfin reconciliation is
// covered separately and must not require a live server in CI.
provisioning.reconcileCustomer=async()=>({active:true,smoke:true});
const referrals=require('../src/referrals');
const credits=require('../src/affiliate-credits');

async function customer(label){
  const user=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,'smoke-hash','customer',TRUE) RETURNING id`,[label,`${label}@example.invalid`])).rows[0];
  return (await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.id,label,`${label}@example.invalid`])).rows[0];
}
async function plan(code,name,price){
  const row=(await query(`INSERT INTO plans(code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'affiliate smoke','jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING id`,[code,name,price])).rows[0];
  await query(`INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default) VALUES($1,'GBP',$2,TRUE,TRUE) ON CONFLICT(plan_id,currency) DO UPDATE SET price_minor=EXCLUDED.price_minor,active=TRUE,is_default=TRUE`,[row.id,price]);
  return row;
}
async function main(){
  const suffix=Date.now().toString(36),affiliate=await customer(`affiliate-${suffix}`),referred=await customer(`referred-${suffix}`);
  const paidPlan=await plan(`affiliate-paid-${suffix}`,'Referral purchase',1000),targetPlan=await plan(`affiliate-target-${suffix}`,'Credit activation',600);
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({enabled:true,rewardPercent:100,qualificationDelayDays:0,refundWindowDays:0})]);

  const enrollment=await credits.enroll(affiliate.id);
  assert(enrollment.code,'Affiliate should receive a referral code without subscribing.');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM subscriptions WHERE customer_id=$1`,[affiliate.id])).rows[0].n),0,'Affiliate unexpectedly has a subscription before earning credit.');

  await referrals.attributeReferral(referred.id,enrollment.code);
  const paidSub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,plan_name_snapshot,service_type_snapshot,commercial_snapshot) VALUES($1,$2,'active','stripe',NOW()-INTERVAL '1 minute',NOW()+INTERVAL '30 days',1000,'GBP','Referral purchase','jellyfin',$3::jsonb) RETURNING id`,[referred.id,paidPlan.id,JSON.stringify({discountedMinor:1000})])).rows[0];
  const rewarded=await referrals.rewardIfQualifying(referred.id);
  assert.equal(rewarded?.rewarded,true,'Qualifying referral did not create affiliate credit.');
  assert.equal(rewarded.amountMinor,1000,'Reward should equal 100% of paid spend in this smoke.');
  assert.equal(rewarded.currency,'GBP');

  await credits.matureDueCredits(affiliate.id);
  let balance=(await credits.balances(affiliate.id)).find(x=>x.currency==='GBP');
  assert.equal(balance?.available_minor,1000,'Affiliate credit is not independently spendable.');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM subscriptions WHERE customer_id=$1`,[affiliate.id])).rows[0].n),0,'Earning credit should not create a subscription.');

  const redeemed=await credits.redeemPlan({customerId:affiliate.id,planCode:`affiliate-target-${suffix}`,currency:'GBP'});
  assert.equal(redeemed.costMinor,600);
  assert.equal(redeemed.balanceAfter,400);
  const serviceSub=(await query(`SELECT source,status,price_minor_snapshot,currency_snapshot FROM subscriptions WHERE id=$1`,[redeemed.subId])).rows[0];
  assert.equal(serviceSub.source,'service_credit','Credit activation must not masquerade as Stripe/PayPal.');
  assert.equal(serviceSub.status,'active');
  assert.equal(Number(serviceSub.price_minor_snapshot),600);
  assert.equal(serviceSub.currency_snapshot,'GBP');
  balance=(await credits.balances(affiliate.id)).find(x=>x.currency==='GBP');
  assert.equal(balance?.available_minor,400,'Redeemed credit was not deducted exactly once.');

  let blocked=false;
  try{await credits.redeemPlan({customerId:affiliate.id,planCode:`affiliate-target-${suffix}`,currency:'GBP'});}catch(error){blocked=true;assert(/need|active service/i.test(error.message));}
  assert(blocked,'A second redemption must not spend the same credit twice.');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='redeemed'`,[affiliate.id])).rows[0].n),1,'Double-spend created a second redemption ledger entry.');

  const referral=(await query(`SELECT id FROM referral_redemptions WHERE referred_customer_id=$1`,[referred.id])).rows[0];
  assert(referral?.id,'Referral attribution disappeared.');
  assert(paidSub.id,'Qualifying paid subscription was not created.');
  console.log('affiliate service credit smoke: ok — no-subscription earn, balance, activation and double-spend guard');
}
main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
