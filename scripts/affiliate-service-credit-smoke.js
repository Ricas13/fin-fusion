'use strict';

const assert=require('assert');
const {query,getPool}=require('../src/db');
const provisioning=require('../src/jellyfin/resilient-provisioning');
// This smoke validates commercial/account state only; Jellyfin reconciliation is
// covered separately and must not require a live server in CI.
provisioning.reconcileCustomer=async()=>({active:true,smoke:true});
const referrals=require('../src/referrals');
const credits=require('../src/affiliate-credits');
const {encryptWithEnv}=require('../src/security/purpose-crypto');

// Fleet capacity fails closed for any jellyfin premium/free plan with no
// matching, enabled jellyfin_servers row (see plan-capacity.js's fleetPlan
// gate) -- without this, every credit redemption below is rejected as sold
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
  `,[`credit-server-${suffix}`,`credit-server-${suffix}`,apiKey])).rows[0].id;
}

async function customer(label){
  const user=(await query(`INSERT INTO app_users(username,email,password_hash,role,active) VALUES($1,$2,'smoke-hash','customer',TRUE) RETURNING id`,[label,`${label}@example.invalid`])).rows[0];
  return (await query(`INSERT INTO customers(user_id,display_name,email) VALUES($1,$2,$3) RETURNING id`,[user.id,label,`${label}@example.invalid`])).rows[0];
}
async function plan(code,name,price){
  const row=(await query(`INSERT INTO plans(code,name,description,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class) VALUES($1,$2,'affiliate smoke','jellyfin','direct','month',30,$3,'GBP',100,TRUE,TRUE,1,'premium') RETURNING id`,[code,name,price])).rows[0];
  await query(`INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default) VALUES($1,'GBP',$2,TRUE,TRUE) ON CONFLICT(plan_id,currency) DO UPDATE SET price_minor=EXCLUDED.price_minor,active=TRUE,is_default=TRUE`,[row.id,price]);
  return row;
}
async function setProgramme(rewardPercent){
  await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({enabled:true,rewardPercent,qualificationDelayDays:0,refundWindowDays:0})]);
}
async function main(){
  const suffix=Date.now().toString(36);
  await ensurePremiumServer(suffix);
  const affiliate=await customer(`affiliate-${suffix}`),referred=await customer(`referred-${suffix}`);
  const paidPlan=await plan(`affiliate-paid-${suffix}`,'Referral purchase',1000),targetPlan=await plan(`affiliate-target-${suffix}`,'Credit activation',600);
  await setProgramme(15);

  const enrollment=await credits.enroll(affiliate.id);
  assert(enrollment.code,'Affiliate should receive a referral code without subscribing.');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM subscriptions WHERE customer_id=$1`,[affiliate.id])).rows[0].n),0,'Affiliate unexpectedly has a subscription before earning credit.');

  await referrals.attributeReferral(referred.id,enrollment.code);
  const paidSub=(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,plan_name_snapshot,service_type_snapshot,commercial_snapshot) VALUES($1,$2,'active','stripe',NOW()-INTERVAL '1 minute',NOW()+INTERVAL '30 days',1000,'GBP','Referral purchase','jellyfin',$3::jsonb) RETURNING id`,[referred.id,paidPlan.id,JSON.stringify({discountedMinor:1000})])).rows[0];
  const rewarded=await referrals.rewardIfQualifying(referred.id);
  assert.equal(rewarded?.rewarded,true,'Qualifying referral did not create affiliate credit.');
  assert.equal(rewarded.amountMinor,150,'Initial reward should preserve the 15% programme rate captured at qualification.');
  assert.equal(rewarded.currency,'GBP');
  const original=(await query(`SELECT id,amount_minor,metadata FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='earned'`,[affiliate.id])).rows[0];
  assert.equal(Number(original.amount_minor),150,'Original earned reward amount was not persisted exactly.');
  assert.equal(Number(original.metadata.rewardPercent),15,'Original earned reward must retain its historical percentage.');
  assert.equal(Number(original.metadata.paidMinor),1000,'Original reward must retain the actual qualifying paid amount for an auditable top-up.');

  // Programme changes are prospective. Historical correction is a separate,
  // immutable adjustment so the original 15% reward/payment evidence is never rewritten.
  await setProgramme(25);
  const topUp=await credits.topUpRewardToCurrentRate({creditId:original.id,reason:'Backfill smoke reward from 15% to 25%'});
  assert.equal(topUp.created,true,'Historical reward did not create a top-up adjustment.');
  assert.equal(topUp.topUpMinor,100,'£10.00 qualifying spend must receive a £1.00 top-up when moving from 15% to 25%.');
  assert.equal(topUp.targetRewardMinor,250);
  const duplicateTopUp=await credits.topUpRewardToCurrentRate({creditId:original.id,reason:'Retry the same historical correction'});
  assert.equal(duplicateTopUp.created,false,'Repeating a current-rate top-up must be idempotent.');
  assert.match(duplicateTopUp.reason,/already_at_or_above|already_recorded/);
  const unchanged=(await query(`SELECT amount_minor,metadata FROM affiliate_credit_ledger WHERE id=$1`,[original.id])).rows[0];
  assert.equal(Number(unchanged.amount_minor),150,'Top-up must not rewrite the original earned reward.');
  assert.equal(Number(unchanged.metadata.rewardPercent),15,'Top-up must not rewrite the original historical rate.');
  assert.equal(Number((await query(`SELECT COALESCE(SUM(amount_minor),0)::int n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='adjustment' AND metadata->>'sourceRewardId'=$2`,[affiliate.id,String(original.id)])).rows[0].n),100,'Historical reward top-up was not recorded as a separate adjustment.');

  await credits.matureDueCredits(affiliate.id);
  let balance=(await credits.balances(affiliate.id)).find(x=>x.currency==='GBP');
  assert.equal(balance?.available_minor,250,'15% reward plus 10-point top-up must produce 25% available service credit.');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM subscriptions WHERE customer_id=$1`,[affiliate.id])).rows[0].n),0,'Earning credit should not create a subscription.');

  // Manual corrections remain separate signed adjustment entries with a reason.
  const added=await credits.adminAdjustCredit({customerId:affiliate.id,currency:'GBP',amountMinor:400,reason:'Manual affiliate reconciliation smoke'});
  assert.equal(added.amountMinor,400);
  const removed=await credits.adminAdjustCredit({customerId:affiliate.id,currency:'GBP',amountMinor:-50,reason:'Correct excess manual credit smoke'});
  assert.equal(removed.amountMinor,-50);
  balance=(await credits.balances(affiliate.id)).find(x=>x.currency==='GBP');
  assert.equal(balance?.available_minor,600,'Signed manual credit adjustments must change the spendable balance exactly once.');
  await assert.rejects(()=>credits.adminAdjustCredit({customerId:affiliate.id,currency:'GBP',amountMinor:-601,reason:'Attempt to overdraw affiliate credit'}),/more GBP credit than is currently spendable/,'Admin correction must not create a negative spendable balance.');

  const redeemed=await credits.redeemPlan({customerId:affiliate.id,planCode:`affiliate-target-${suffix}`,currency:'GBP'});
  assert.equal(redeemed.costMinor,600);
  assert.equal(redeemed.balanceAfter,0);
  const serviceSub=(await query(`SELECT source,status,price_minor_snapshot,currency_snapshot FROM subscriptions WHERE id=$1`,[redeemed.subId])).rows[0];
  assert.equal(serviceSub.source,'service_credit','Credit activation must not masquerade as Stripe/PayPal.');
  assert.equal(serviceSub.status,'active');
  assert.equal(Number(serviceSub.price_minor_snapshot),600);
  assert.equal(serviceSub.currency_snapshot,'GBP');
  balance=(await credits.balances(affiliate.id)).find(x=>x.currency==='GBP');
  assert.equal(balance?.available_minor,0,'Redeemed credit was not deducted exactly once.');

  let blocked=false;
  try{await credits.redeemPlan({customerId:affiliate.id,planCode:`affiliate-target-${suffix}`,currency:'GBP'});}catch(error){blocked=true;assert(/need|active service/i.test(error.message));}
  assert(blocked,'A second redemption must not spend the same credit twice.');
  assert.equal(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='redeemed'`,[affiliate.id])).rows[0].n),1,'Double-spend created a second redemption ledger entry.');

  const referral=(await query(`SELECT id FROM referral_redemptions WHERE referred_customer_id=$1`,[referred.id])).rows[0];
  assert(referral?.id,'Referral attribution disappeared.');
  assert(paidSub.id,'Qualifying paid subscription was not created.');
  const actions=(await query(`SELECT action FROM audit_log WHERE action IN('admin.affiliate.credit.top_up','admin.affiliate.credit.adjustment')`)).rows.map(row=>row.action);
  assert(actions.includes('admin.affiliate.credit.top_up'),'Historical top-up must be audited.');
  assert(actions.filter(action=>action==='admin.affiliate.credit.adjustment').length>=2,'Manual affiliate adjustments must be audited.');
  console.log('affiliate service credit smoke: ok — immutable 15→25 top-up, manual adjustments, activation and double-spend guard');
}
main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);try{await getPool().end();}catch(_){}process.exit(1);});
