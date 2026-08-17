'use strict';

const {query,transaction}=require('./db');
const planPricing=require('./payments/plan-pricing');
const provisioning=require('./jellyfin/resilient-provisioning');

function cleanCurrency(value){return planPricing.cleanCurrency(value,'GBP');}
function clampInt(value,min,max,fallback){const n=Number.parseInt(value,10);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}

async function loadSettings(){
  const r=await query("SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'");
  const v=r.rows[0]?.setting_value||{};
  return {
    enabled:v.enabled===true,
    rewardPercent:clampInt(v.rewardPercent,1,100,15),
    qualificationDelayDays:clampInt(v.qualificationDelayDays,0,90,14),
    refundWindowDays:clampInt(v.refundWindowDays,0,90,14)
  };
}

async function enroll(customerId){
  await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)
    ON CONFLICT(customer_id) DO UPDATE SET active=TRUE,disabled_at=NULL,updated_at=NOW()`,[customerId]);
  const referrals=require('./referrals');
  const code=await referrals.ensureReferralCode(customerId);
  return{customerId,code};
}

async function profile(customerId){
  const [p,b]=await Promise.all([
    query(`SELECT ap.*,rc.code FROM affiliate_profiles ap LEFT JOIN referral_codes rc ON rc.customer_id=ap.customer_id WHERE ap.customer_id=$1`,[customerId]),
    balances(customerId)
  ]);
  return{profile:p.rows[0]||null,balances:b};
}

async function balances(customerId){
  const r=await query(`SELECT currency,
    COALESCE(SUM(amount_minor) FILTER(WHERE state='available'),0)::int AS available_minor,
    COALESCE(SUM(amount_minor) FILTER(WHERE state='pending'),0)::int AS pending_minor,
    COALESCE(SUM(amount_minor) FILTER(WHERE state IN('available','pending')),0)::int AS total_minor
    FROM affiliate_credit_ledger WHERE customer_id=$1 GROUP BY currency ORDER BY currency`,[customerId]);
  return r.rows.map(row=>({...row,available_minor:Number(row.available_minor||0),pending_minor:Number(row.pending_minor||0),total_minor:Number(row.total_minor||0)}));
}

async function matureDueCredits(customerId=null){
  const params=[];let where=`state='pending' AND available_at IS NOT NULL AND available_at<=NOW()`;
  if(customerId){params.push(customerId);where+=` AND customer_id=$${params.length}`;}
  const r=await query(`UPDATE affiliate_credit_ledger SET state='available' WHERE ${where} RETURNING id`,params);
  return r.rowCount;
}

async function createPendingReward({affiliateCustomerId,referredCustomerId,redemptionId,qualifyingSubscriptionId,paidMinor,currency,availableAt,referenceId,metadata={}}){
  const amount=Number(paidMinor),settings=await loadSettings();
  if(!settings.enabled)return{created:false,reason:'disabled'};
  if(!Number.isInteger(amount)||amount<=0)return{created:false,reason:'no_paid_value'};
  const reward=Math.max(1,Math.floor(amount*settings.rewardPercent/100));
  await enroll(affiliateCustomerId);
  const r=await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,referral_redemption_id,referred_customer_id,qualifying_subscription_id,available_at,reference_id,note,metadata)
    VALUES($1,$2,$3,'earned','pending',$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING id,amount_minor,currency,available_at`,[
      affiliateCustomerId,cleanCurrency(currency),reward,redemptionId,referredCustomerId,qualifyingSubscriptionId,availableAt,referenceId,
      `Affiliate reward: ${settings.rewardPercent}% of qualifying paid service`,JSON.stringify({...metadata,rewardPercent:settings.rewardPercent,paidMinor:amount})
    ]);
  return r.rowCount?{created:true,...r.rows[0],amountMinor:reward}:{created:false,reason:'already_recorded'};
}

async function reverseReward({redemptionId,paymentIncidentId=null,reason='payment_reversal'}={}){
  if(!redemptionId)return{reversed:false,reason:'missing_redemption'};
  return transaction(async client=>{
    const earned=await client.query(`SELECT * FROM affiliate_credit_ledger WHERE referral_redemption_id=$1 AND entry_type='earned' ORDER BY created_at LIMIT 1 FOR UPDATE`,[redemptionId]);
    if(!earned.rowCount)return{reversed:false,reason:'no_credit'};
    const row=earned.rows[0];
    if(row.state==='void')return{reversed:false,reason:'already_void'};
    const used=await client.query(`SELECT COALESCE(SUM(-amount_minor),0)::int used FROM affiliate_credit_ledger WHERE customer_id=$1 AND currency=$2 AND entry_type='redeemed' AND metadata->>'sourceRewardId'=$3`,[row.customer_id,row.currency,String(row.id)]);
    // A reversal never creates a negative spendable balance. If credit has already
    // been consumed, preserve delivered service and record only the unspent part.
    const current=await client.query(`SELECT COALESCE(SUM(amount_minor),0)::int balance FROM affiliate_credit_ledger WHERE customer_id=$1 AND currency=$2 AND state='available'`,[row.customer_id,row.currency]);
    const reversible=Math.min(Number(row.amount_minor),Math.max(0,Number(current.rows[0]?.balance||0)));
    await client.query(`UPDATE affiliate_credit_ledger SET state='void',note=note||' · reversed: '||$2 WHERE id=$1`,[row.id,String(reason).slice(0,180)]);
    if(reversible>0)await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,referral_redemption_id,payment_incident_id,reference_id,note,metadata)
      VALUES($1,$2,$3,'reversed','available',$4,$5,$6,$7,$8::jsonb) ON CONFLICT(entry_type,reference_id) DO NOTHING`,[
        row.customer_id,row.currency,-reversible,redemptionId,paymentIncidentId,`affiliate-reversal:${redemptionId}`,String(reason).slice(0,200),JSON.stringify({earnedCreditId:row.id,originalAmountMinor:Number(row.amount_minor),reversibleMinor:reversible,alreadyConsumedMinor:Number(used.rows[0]?.used||0)})
      ]);
    return{reversed:true,amountMinor:reversible,currency:row.currency,customerId:row.customer_id};
  });
}

async function redeemPlan({customerId,planCode,currency}){
  await matureDueCredits(customerId);
  const wanted=cleanCurrency(currency);
  const result=await transaction(async client=>{
    const customer=await client.query(`SELECT id FROM customers WHERE id=$1 FOR UPDATE`,[customerId]);
    if(!customer.rowCount)throw new Error('Customer account not found.');
    const affiliate=await client.query(`SELECT active FROM affiliate_profiles WHERE customer_id=$1`,[customerId]);
    if(!affiliate.rows[0]?.active)throw new Error('Enable your affiliate account before using service credit.');
    const plan=(await client.query(`SELECT * FROM plans WHERE code=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND audience IN('direct','both') LIMIT 1`,[String(planCode||'').trim()])).rows[0];
    if(!plan)throw new Error('That plan is not available.');
    const price=(await client.query(`SELECT * FROM plan_prices WHERE plan_id=$1 AND currency=$2 AND active=TRUE LIMIT 1`,[plan.id,wanted])).rows[0];
    if(!price)throw new Error(`That plan is not available in ${wanted}.`);
    const cost=Number(price.price_minor||0);
    if(cost<=0)throw new Error('Free plans do not use affiliate credit.');
    const bal=(await client.query(`SELECT COALESCE(SUM(amount_minor),0)::int amount FROM affiliate_credit_ledger WHERE customer_id=$1 AND currency=$2 AND state='available'`,[customerId,wanted])).rows[0];
    const available=Number(bal?.amount||0);
    if(available<cost)throw new Error(`You need ${cost-available} more ${wanted} minor units of service credit for this plan.`);
    const live=await client.query(`SELECT subscription_id FROM effective_customer_entitlements WHERE customer_id=$1 LIMIT 1`,[customerId]);
    if(live.rowCount)throw new Error('You already have active service. Use your existing subscription controls before activating another plan.');
    const days=Math.max(1,Number(plan.duration_days||30)),starts=new Date(),ends=new Date(starts.getTime()+days*86400000);
    const sub=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,plan_name_snapshot,service_type_snapshot)
      VALUES($1,$2,'active','service_credit',$3,$4,$5,$6,$7,$8) RETURNING id`,[customerId,plan.id,starts,ends,cost,wanted,plan.name,plan.service_type||'jellyfin'])).rows[0];
    await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,applied_subscription_id,reference_id,note,metadata)
      VALUES($1,$2,$3,'redeemed','available',$4,$5,$6,$7::jsonb)`,[customerId,wanted,-cost,sub.id,`subscription:${sub.id}`,`Redeemed service credit for ${plan.name}`,JSON.stringify({planId:plan.id,planCode:plan.code,planPriceId:price.id,costMinor:cost})]);
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.redeem','subscription',$1,$2::jsonb)`,[sub.id,JSON.stringify({customerId,planId:plan.id,planCode:plan.code,currency:wanted,costMinor:cost})]);
    return{subId:sub.id,planId:plan.id,costMinor:cost,currency:wanted,balanceAfter:available-cost};
  });
  await provisioning.reconcileCustomer(customerId);
  return result;
}

module.exports={loadSettings,enroll,profile,balances,matureDueCredits,createPendingReward,reverseReward,redeemPlan,cleanCurrency};
