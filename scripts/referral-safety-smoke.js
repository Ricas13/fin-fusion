'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {query,getPool}=require('../src/db');
const referrals=require('../src/referrals');

const suffix=crypto.randomBytes(6).toString('hex');
const email=name=>`ref-${name}-${suffix}@example.invalid`;
async function customer(name,address=email(name)){return(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`Referral ${name} ${suffix}`,address])).rows[0]}
async function plan(name){return(await query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible) VALUES($1,$2,'direct','month',30,1000,'GBP',2,'premium',TRUE,TRUE) RETURNING *`,[`ref-${name}-${suffix}`,`Referral ${name} ${suffix}`])).rows[0]}
async function subscription(customerId,planId,{source='manual',discountedMinor=1000,daysAgo=30}={}){return(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,price_minor_snapshot,currency_snapshot,commercial_snapshot) VALUES($1,$2,'active',$3,NOW()-($4::int*INTERVAL '1 day'),NOW()+INTERVAL '30 days',$5,1000,'GBP',$6::jsonb) RETURNING *`,[customerId,planId,source,daysAgo,['stripe','paypal'].includes(source)?`${source}_ref_${crypto.randomUUID()}`:null,JSON.stringify({kind:'direct_plan',discountedMinor,priceMinor:1000})])).rows[0]}

async function main(){
  try{
    await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('referral_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({enabled:true,rewardDays:7,qualificationDelayDays:0,refundWindowDays:0})]);
    const refPlan=await plan('referrer'),paidPlan=await plan('paid');

    // Same normalized email cannot refer itself through a second customer row.
    const shared=email('shared'),sameReferrer=await customer('same-referrer',shared),sameReferred=await customer('same-referred',shared);
    const sameCode=await referrals.ensureReferralCode(sameReferrer.id);
    assert.strictEqual(await referrals.attributeReferral(sameReferred.id,sameCode),null,'Same-email referral was attributed');

    // A zero-value provider checkout must not count as a qualifying paid event,
    // even when the catalogue/list price and snapshot price were non-zero.
    const zeroReferrer=await customer('zero-referrer'),zeroReferred=await customer('zero-referred');
    await subscription(zeroReferrer.id,refPlan.id,{source:'manual'});
    const zeroCode=await referrals.ensureReferralCode(zeroReferrer.id);
    assert(await referrals.attributeReferral(zeroReferred.id,zeroCode),'Zero-value test referral was not attributed');
    await subscription(zeroReferred.id,paidPlan.id,{source:'stripe',discountedMinor:0});
    const zeroResult=await referrals.rewardIfQualifying(zeroReferred.id);
    assert.strictEqual(zeroResult?.reason,'no_qualifying_paid_event','Zero-value provider checkout qualified for a referral reward');
    const zeroRedemption=await query(`SELECT status FROM referral_redemptions WHERE referred_customer_id=$1`,[zeroReferred.id]);
    assert.strictEqual(zeroRedemption.rows[0]?.status,'pending','Zero-value referral should remain pending for a future qualifying paid event');

    // Positive provider payment after the configured window grants exactly one
    // provider-independent extension; reprocessing is idempotent.
    const paidReferrer=await customer('paid-referrer'),paidReferred=await customer('paid-referred');
    const referrerSubscription=await subscription(paidReferrer.id,refPlan.id,{source:'manual'});
    const paidCode=await referrals.ensureReferralCode(paidReferrer.id);
    assert(await referrals.attributeReferral(paidReferred.id,paidCode),'Paid referral was not attributed');
    await subscription(paidReferred.id,paidPlan.id,{source:'paypal',discountedMinor:500,daysAgo:2});
    const reward=await referrals.rewardIfQualifying(paidReferred.id);
    assert.strictEqual(reward?.rewarded,true,'Qualifying paid referral was not rewarded');
    const after=await query(`SELECT service_extension_days FROM subscriptions WHERE id=$1`,[referrerSubscription.id]);
    assert.strictEqual(Number(after.rows[0]?.service_extension_days),7,'Referral reward did not add the configured extension');
    const repeat=await referrals.rewardIfQualifying(paidReferred.id);
    assert.strictEqual(repeat,null,'Already-rewarded referral was processed twice');
    const events=await query(`SELECT COUNT(*)::int n FROM subscription_service_extension_events WHERE subscription_id=$1 AND source='referral'`,[referrerSubscription.id]);
    assert.strictEqual(Number(events.rows[0].n),1,'Referral reward created duplicate extension events');

    console.log('Referral safety smoke test passed.');
  }finally{await getPool().end();}
}
main().catch(error=>{console.error(error);process.exit(1)});
