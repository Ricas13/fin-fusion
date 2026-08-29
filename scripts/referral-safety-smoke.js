'use strict';

require('dotenv').config();
const assert=require('assert');
const crypto=require('crypto');
const {query,transaction,getPool}=require('../src/db');
const referrals=require('../src/referrals');
const incidents=require('../src/payments/incidents');
const credits=require('../src/affiliate-credits');

const suffix=crypto.randomBytes(6).toString('hex');
const email=name=>`ref-${name}-${suffix}@example.invalid`;
async function customer(name,address=email(name)){return(await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,[`Referral ${name} ${suffix}`,address])).rows[0];}
async function plan(name){return(await query(`INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible) VALUES($1,$2,'direct','month',30,1000,'GBP',2,'premium',TRUE,TRUE) RETURNING *`,[`ref-${name}-${suffix}`,`Referral ${name} ${suffix}`])).rows[0];}
async function subscription(customerId,planId,{source='stripe',discountedMinor=1000,daysAgo=2}={}){return(await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,price_minor_snapshot,currency_snapshot,commercial_snapshot) VALUES($1,$2,'active',$3,NOW()-($4::int*INTERVAL '1 day'),NOW()+INTERVAL '30 days',$5,1000,'GBP',$6::jsonb) RETURNING *`,[customerId,planId,source,daysAgo,['stripe','paypal'].includes(source)?`${source}_ref_${crypto.randomUUID()}`:null,JSON.stringify({kind:'direct_plan',discountedMinor,priceMinor:1000})])).rows[0];}

async function main(){
  try{
    await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('affiliate_program',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[JSON.stringify({enabled:true,rewardPercent:50,qualificationDelayDays:0,refundWindowDays:0})]);
    const paidPlan=await plan('paid');

    // A transaction-aware attribution must roll back with the caller rather than
    // escaping through the global pool and leaving a redemption behind.
    const txReferrer=await customer('tx-referrer'),txReferred=await customer('tx-referred');
    const txCode=await referrals.ensureReferralCode(txReferrer.id);
    await assert.rejects(transaction(async client=>{
      assert(await referrals.attributeReferral(txReferred.id,txCode,client),'Transactional referral was not attributed inside the transaction');
      throw new Error('rollback referral attribution');
    }),/rollback referral attribution/);
    assert.strictEqual(Number((await query(`SELECT COUNT(*) n FROM referral_redemptions WHERE referred_customer_id=$1`,[txReferred.id])).rows[0].n),0,'Rolled-back referral attribution escaped its caller transaction');

    // Re-attribution must report the persisted referral, not the second code that
    // lost the referred-customer uniqueness conflict.
    const firstReferrer=await customer('first-referrer'),secondReferrer=await customer('second-referrer'),oneReferred=await customer('one-referred');
    const firstCode=await referrals.ensureReferralCode(firstReferrer.id),secondCode=await referrals.ensureReferralCode(secondReferrer.id);
    const firstReferralId=await referrals.attributeReferral(oneReferred.id,firstCode);
    const secondAttemptId=await referrals.attributeReferral(oneReferred.id,secondCode);
    assert.strictEqual(String(secondAttemptId),String(firstReferralId),'Referral conflict returned the attempted code instead of the persisted attribution');
    assert.strictEqual(Number((await query(`SELECT COUNT(*) n FROM referral_redemptions WHERE referred_customer_id=$1`,[oneReferred.id])).rows[0].n),1,'Re-attribution created more than one redemption');

    // Same normalized identity cannot self-refer through a second customer row.
    const shared=email('shared'),sameReferrer=await customer('same-referrer',shared),sameReferred=await customer('same-referred',shared);
    const sameCode=await referrals.ensureReferralCode(sameReferrer.id);
    assert.strictEqual(await referrals.attributeReferral(sameReferred.id,sameCode),null,'Same-email referral was attributed');

    // A zero-value provider checkout must never create affiliate credit.
    const zeroReferrer=await customer('zero-referrer'),zeroReferred=await customer('zero-referred');
    const zeroCode=await referrals.ensureReferralCode(zeroReferrer.id);
    assert(await referrals.attributeReferral(zeroReferred.id,zeroCode),'Zero-value test referral was not attributed');
    await subscription(zeroReferred.id,paidPlan.id,{source:'stripe',discountedMinor:0});
    const zeroResult=await referrals.rewardIfQualifying(zeroReferred.id);
    assert.strictEqual(zeroResult?.rewarded,false,'Zero-value provider checkout qualified for affiliate credit');
    assert.strictEqual(zeroResult?.reason,'no_qualifying_paid_event','Zero-value provider checkout was not rejected for lack of paid value');
    const zeroRedemption=await query(`SELECT status FROM referral_redemptions WHERE referred_customer_id=$1`,[zeroReferred.id]);
    assert.strictEqual(zeroRedemption.rows[0]?.status,'pending','Zero-value referral should remain pending for a future qualifying paid event');
    assert.strictEqual(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE customer_id=$1`,[zeroReferrer.id])).rows[0].n),0,'Zero-value checkout created service credit');

    // Refund/chargeback evidence before qualification disqualifies the reward.
    const refundReferrer=await customer('refund-referrer'),refundReferred=await customer('refund-referred');
    const refundCode=await referrals.ensureReferralCode(refundReferrer.id);
    assert(await referrals.attributeReferral(refundReferred.id,refundCode),'Refund test referral was not attributed');
    const refundedPurchase=await subscription(refundReferred.id,paidPlan.id,{source:'stripe',discountedMinor:500});
    await incidents.record({provider:'stripe',eventId:`evt_refund_${suffix}`,caseId:`ch_refund_${suffix}`,kind:'refund',status:'recorded',identity:{scope:'direct',customerId:refundReferred.id},providerSubscriptionId:refundedPurchase.provider_subscription_id,amountMinor:500,currency:'GBP',metadata:{fullRefund:true}});
    const refundResult=await referrals.rewardIfQualifying(refundReferred.id);
    assert.strictEqual(refundResult?.reason,'payment_reversed','Refunded qualifying payment still earned affiliate credit');
    assert.strictEqual((await query(`SELECT status FROM referral_redemptions WHERE referred_customer_id=$1`,[refundReferred.id])).rows[0]?.status,'unfulfilled','Refunded referral was not disqualified');
    assert.strictEqual(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE customer_id=$1`,[refundReferrer.id])).rows[0].n),0,'Refunded referral created affiliate credit');

    // Positive provider payment grants same-currency monetary credit exactly once.
    const paidReferrer=await customer('paid-referrer'),paidReferred=await customer('paid-referred');
    const paidCode=await referrals.ensureReferralCode(paidReferrer.id);
    assert(await referrals.attributeReferral(paidReferred.id,paidCode),'Paid referral was not attributed');
    const paidPurchase=await subscription(paidReferred.id,paidPlan.id,{source:'paypal',discountedMinor:500});
    const reward=await referrals.rewardIfQualifying(paidReferred.id);
    assert.strictEqual(reward?.rewarded,true,'Qualifying paid referral was not rewarded');
    assert.strictEqual(reward.amountMinor,250,'50% affiliate reward must equal half of actual paid value');
    assert.strictEqual(reward.currency,'GBP');
    await credits.matureDueCredits(paidReferrer.id);
    let balance=(await credits.balances(paidReferrer.id)).find(row=>row.currency==='GBP');
    assert.strictEqual(Number(balance?.available_minor||0),250,'Affiliate credit did not become available');
    assert.strictEqual(await referrals.rewardIfQualifying(paidReferred.id),null,'Already-rewarded referral was processed twice');
    assert.strictEqual(Number((await query(`SELECT COUNT(*) n FROM affiliate_credit_ledger WHERE customer_id=$1 AND entry_type='earned'`,[paidReferrer.id])).rows[0].n),1,'Referral reward created duplicate earned-credit entries');

    // A later adverse payment removes only still-unspent credit and preserves service.
    // Reversal is grounded in the same durable incident evidence production webhooks record.
    const chargeback=await incidents.record({provider:'paypal',eventId:`evt_chargeback_${suffix}`,caseId:`case_chargeback_${suffix}`,kind:'chargeback',status:'lost',identity:{scope:'direct',customerId:paidReferred.id},providerSubscriptionId:paidPurchase.provider_subscription_id,amountMinor:500,currency:'GBP',metadata:{smoke:true}});
    const reversal=await referrals.revisitRewardAfterAdversePayment({referredCustomerId:paidReferred.id,incidentId:chargeback.incident.id,reason:'smoke_chargeback'});
    assert.strictEqual(reversal.reversed,true,'Adverse payment did not reverse unspent affiliate credit');
    balance=(await credits.balances(paidReferrer.id)).find(row=>row.currency==='GBP');
    assert.strictEqual(Number(balance?.available_minor||0),0,'Reversed affiliate credit remained spendable');
    assert.strictEqual((await query(`SELECT status FROM referral_redemptions WHERE referred_customer_id=$1`,[paidReferred.id])).rows[0]?.status,'reversed','Referral status did not record the reversal');

    console.log('Referral safety smoke test passed for affiliate service credits.');
  }finally{await getPool().end();}
}
main().catch(error=>{console.error(error);process.exit(1)});