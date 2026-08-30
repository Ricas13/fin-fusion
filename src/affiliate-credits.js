'use strict';

const crypto=require('crypto');
const {query,transaction}=require('./db');
const planPricing=require('./payments/plan-pricing');
const serviceCreditReservations=require('./payments/service-credit-reservations');
const accounting=require('./payments/service-credit-accounting');
const commerce=require('./payments/commerce-control');
const billingPeriods=require('./payments/billing-periods');
const planCapacity=require('./entitlements/plan-capacity');
const serviceScope=require('./entitlements/service-scope');
const provisioning=require('./jellyfin/resilient-provisioning');

function cleanCurrency(value){return planPricing.cleanCurrency(value,'GBP');}
function clampInt(value,min,max,fallback){const n=Number.parseInt(value,10);return Number.isFinite(n)?Math.max(min,Math.min(max,n)):fallback;}
function requiredReason(value){const reason=String(value||'').trim();if(reason.length<3)throw new Error('Enter a reason for this affiliate credit adjustment.');return reason.slice(0,500);}
function settingsValue(v={}){return{enabled:v.enabled===true,rewardPercent:clampInt(v.rewardPercent,1,100,15),qualificationDelayDays:clampInt(v.qualificationDelayDays,0,90,14),refundWindowDays:clampInt(v.refundWindowDays,0,90,14)};}
async function settingsFor(client){const r=await client.query("SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'");return settingsValue(r.rows[0]?.setting_value||{});}
async function loadSettings(){return settingsFor({query});}

async function enroll(customerId){
  await query(`INSERT INTO affiliate_profiles(customer_id,active) VALUES($1,TRUE)
    ON CONFLICT(customer_id) DO UPDATE SET active=TRUE,disabled_at=NULL,updated_at=NOW()`,[customerId]);
  const referrals=require('./referrals');
  const code=await referrals.ensureReferralCode(customerId);
  return{customerId,code};
}

async function referralActivity(customerId){
  const r=await query(`SELECT rr.id,rr.status,rr.created_at,rr.rewarded_at,rr.reward_note,
      l.id credit_id,l.state credit_state,l.currency,l.amount_minor,l.available_at,l.metadata,
      COALESCE(adj.top_up_minor,0)::int top_up_minor
    FROM referral_redemptions rr
    JOIN referral_codes rc ON rc.id=rr.referral_code_id
    LEFT JOIN affiliate_credit_ledger l ON l.referral_redemption_id=rr.id AND l.entry_type='earned'
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(a.amount_minor),0)::int top_up_minor
      FROM affiliate_credit_ledger a
      WHERE l.id IS NOT NULL AND a.entry_type='adjustment' AND a.state<>'void'
        AND a.metadata->>'sourceRewardId'=l.id::text
    ) adj ON TRUE
    WHERE rc.customer_id=$1
    ORDER BY rr.created_at DESC LIMIT 50`,[customerId]);
  return r.rows.map(row=>({...row,amount_minor:Number(row.amount_minor||0),top_up_minor:Number(row.top_up_minor||0),total_reward_minor:Number(row.amount_minor||0)+Number(row.top_up_minor||0)}));
}

async function profile(customerId){
  const [p,b,r]=await Promise.all([
    query(`SELECT ap.*,rc.code FROM affiliate_profiles ap LEFT JOIN referral_codes rc ON rc.customer_id=ap.customer_id WHERE ap.customer_id=$1`,[customerId]),
    balances(customerId),referralActivity(customerId)
  ]);
  return{profile:p.rows[0]||null,balances:b,referrals:r};
}

async function balances(customerId){
  const r=await query(`WITH currencies AS (
      SELECT currency FROM affiliate_credit_ledger WHERE customer_id=$1
      UNION SELECT currency FROM affiliate_credit_checkout_reservations WHERE customer_id=$1
      UNION SELECT currency FROM affiliate_credit_renewal_reservations WHERE customer_id=$1
      UNION SELECT currency FROM affiliate_credit_recoveries WHERE customer_id=$1
    ) SELECT c.currency,
      (COALESCE((SELECT SUM(l.amount_minor) FROM affiliate_credit_ledger l WHERE l.customer_id=$1 AND l.currency=c.currency AND l.state='available'),0)
       -COALESCE((SELECT SUM(r.amount_minor) FROM affiliate_credit_checkout_reservations r WHERE r.customer_id=$1 AND r.currency=c.currency AND r.state='reserved' AND r.expires_at>NOW()),0)
       -COALESCE((SELECT SUM(r.amount_minor) FROM affiliate_credit_renewal_reservations r WHERE r.customer_id=$1 AND r.currency=c.currency AND r.state IN('reserved','provider_applied')),0))::int AS available_minor,
      COALESCE((SELECT SUM(l.amount_minor) FROM affiliate_credit_ledger l WHERE l.customer_id=$1 AND l.currency=c.currency AND l.state='pending'),0)::int AS pending_minor,
      COALESCE((SELECT SUM(x.amount_minor-x.recovered_minor) FROM affiliate_credit_recoveries x WHERE x.customer_id=$1 AND x.currency=c.currency),0)::int AS recoverable_minor
    FROM currencies c ORDER BY c.currency`,[customerId]);
  return r.rows.map(row=>{
    const available=Number(row.available_minor||0),pending=Number(row.pending_minor||0),recoverable=Number(row.recoverable_minor||0);
    if(available<0||pending<0)throw new Error(`Service-credit accounting invariant violated for ${row.currency}: available=${available}, pending=${pending}.`);
    return{...row,available_minor:available,pending_minor:pending,recoverable_minor:recoverable,total_minor:available+pending};
  });
}

async function matureDueCredits(customerId=null){
  const params=[];let where=`state='pending' AND available_at IS NOT NULL AND available_at<=NOW()`;
  if(customerId){params.push(customerId);where+=` AND customer_id=$${params.length}`;}
  const r=await query(`UPDATE affiliate_credit_ledger SET state='available' WHERE ${where} RETURNING id`,params);return r.rowCount;
}

async function createPendingReward({affiliateCustomerId,referredCustomerId,redemptionId,qualifyingSubscriptionId,paidMinor,currency,availableAt,referenceId,metadata={}}){
  const amount=Number(paidMinor),settings=await loadSettings();
  if(!settings.enabled)return{created:false,reason:'disabled'};
  if(!Number.isInteger(amount)||amount<=0)return{created:false,reason:'no_paid_value'};
  const reward=Math.max(1,Math.floor(amount*settings.rewardPercent/100));
  await enroll(affiliateCustomerId);
  const r=await query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,referral_redemption_id,referred_customer_id,qualifying_subscription_id,available_at,reference_id,note,metadata)
    VALUES($1,$2,$3,'earned','pending',$4,$5,$6,$7,$8,$9,$10::jsonb)
    ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING id,amount_minor,currency,available_at`,[affiliateCustomerId,cleanCurrency(currency),reward,redemptionId,referredCustomerId,qualifyingSubscriptionId,availableAt,referenceId,`Affiliate reward: ${settings.rewardPercent}% of qualifying paid service`,JSON.stringify({...metadata,rewardPercent:settings.rewardPercent,paidMinor:amount})]);
  return r.rowCount?{created:true,...r.rows[0],amountMinor:reward}:{created:false,reason:'already_recorded'};
}

async function refundStateForReward(client,row){
  const sub=(await client.query(`SELECT source,provider_subscription_id FROM subscriptions WHERE id=$1`,[row.qualifying_subscription_id])).rows[0]||{};
  const incidents=await client.query(`SELECT provider,incident_type,incident_status,amount_minor FROM payment_incidents WHERE customer_id=$1 AND provider=$2 AND provider_subscription_id=$3 AND incident_type IN('refund','chargeback') ORDER BY created_at,id`,[row.referred_customer_id,sub.source,sub.provider_subscription_id]);
  const chargeback=incidents.rows.some(x=>x.incident_type==='chargeback'&&String(x.incident_status||'').toLowerCase()!=='won');
  const refunds=incidents.rows.filter(x=>x.incident_type==='refund').map(x=>Math.max(0,Number(x.amount_minor||0)));
  const refunded=sub.source==='stripe'?(refunds.length?Math.max(...refunds):0):refunds.reduce((a,b)=>a+b,0);
  return{chargeback,refundedMinor:refunded,provider:sub.source};
}

async function topUpRewardToCurrentRate({creditId,actorUserId=null,reason}={}){
  const note=requiredReason(reason);if(!creditId)throw new Error('Choose a referral reward to top up.');
  return transaction(async client=>{
    const candidate=await client.query(`SELECT id,customer_id FROM affiliate_credit_ledger WHERE id=$1 AND entry_type='earned'`,[creditId]);
    if(!candidate.rowCount)throw new Error('Affiliate reward not found.');
    await accounting.lockCustomer(client,candidate.rows[0].customer_id);
    const earned=await client.query(`SELECT * FROM affiliate_credit_ledger WHERE id=$1 AND entry_type='earned' FOR UPDATE`,[creditId]);
    if(!earned.rowCount)throw new Error('Affiliate reward not found.');
    const row=earned.rows[0];if(row.state==='void')throw new Error('A reversed affiliate reward cannot be topped up.');
    await accounting.ensureHistoricalAllocations(client,row.customer_id,row.currency);
    const metadata=row.metadata&&typeof row.metadata==='object'?row.metadata:{},grossPaidMinor=Number(metadata.grossPaidMinor||metadata.paidMinor);
    if(!Number.isInteger(grossPaidMinor)||grossPaidMinor<=0)throw new Error('The original qualifying payment amount is unavailable for this reward. Use a manual credit adjustment instead.');
    const adverse=row.qualifying_subscription_id?await refundStateForReward(client,row):{chargeback:false,refundedMinor:0};
    const paidMinor=adverse.chargeback?0:Math.max(0,grossPaidMinor-Math.min(grossPaidMinor,adverse.refundedMinor));
    if(paidMinor<=0)throw new Error('This affiliate reward has no remaining qualifying paid value to top up.');
    const settings=await settingsFor(client),targetRewardMinor=Math.max(1,Math.floor(paidMinor*settings.rewardPercent/100));
    const prior=await client.query(`SELECT
        COALESCE(SUM(CASE WHEN entry_type='adjustment' AND amount_minor>0 AND state<>'void' AND metadata->>'sourceRewardId'=$2 THEN amount_minor ELSE 0 END),0)::int topups,
        COALESCE(SUM(CASE WHEN entry_type='reversed' AND state<>'void' AND (metadata->>'sourceRewardId'=$2 OR metadata->>'earnedCreditId'=$2) THEN -amount_minor ELSE 0 END),0)::int reversed
      FROM affiliate_credit_ledger WHERE customer_id=$1`,[row.customer_id,String(row.id)]);
    const recovery=await accounting.recoveryForReward(client,row.id);
    const currentRewardMinor=Number(row.amount_minor||0)+Number(prior.rows[0]?.topups||0)-Number(prior.rows[0]?.reversed||0)-Number(recovery.amountMinor||0),topUpMinor=targetRewardMinor-currentRewardMinor;
    if(topUpMinor<=0)return{created:false,reason:'already_at_or_above_current_rate',customerId:row.customer_id,currency:row.currency,currentRewardMinor,targetRewardMinor,targetRewardPercent:settings.rewardPercent};
    const availableAt=row.available_at?new Date(row.available_at):new Date(),state=row.state==='pending'&&availableAt.getTime()>Date.now()?'pending':'available',referenceId=`affiliate-rate-topup:${row.id}:${settings.rewardPercent}`;
    const inserted=await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,referral_redemption_id,referred_customer_id,qualifying_subscription_id,available_at,reference_id,note,metadata)
      VALUES($1,$2,$3,'adjustment',$4,$5,$6,$7,$8,$9,$10,$11::jsonb) ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING id`,[row.customer_id,row.currency,topUpMinor,state,row.referral_redemption_id,row.referred_customer_id,row.qualifying_subscription_id,availableAt,referenceId,`Referral reward top-up to ${settings.rewardPercent}% · ${note}`,JSON.stringify({adjustmentKind:'rate_top_up',sourceRewardId:String(row.id),sourceReferenceId:row.reference_id||null,originalRewardPercent:Number(metadata.rewardPercent||0)||null,targetRewardPercent:settings.rewardPercent,grossPaidMinor,paidMinor,targetRewardMinor,previousGrantedMinor:currentRewardMinor,reason:note,actorUserId})]);
    if(!inserted.rowCount)return{created:false,reason:'already_recorded',customerId:row.customer_id,currency:row.currency,currentRewardMinor,targetRewardMinor,targetRewardPercent:settings.rewardPercent};
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.affiliate.credit.top_up','affiliate_credit',$2,$3::jsonb)`,[actorUserId,String(inserted.rows[0].id),JSON.stringify({customerId:row.customer_id,sourceRewardId:row.id,referralRedemptionId:row.referral_redemption_id,currency:row.currency,grossPaidMinor,paidMinor,originalRewardMinor:Number(row.amount_minor||0),previousGrantedMinor:currentRewardMinor,targetRewardMinor,topUpMinor,originalRewardPercent:Number(metadata.rewardPercent||0)||null,targetRewardPercent:settings.rewardPercent,reason:note})]);
    return{created:true,id:inserted.rows[0].id,customerId:row.customer_id,currency:row.currency,topUpMinor,currentRewardMinor,targetRewardMinor,targetRewardPercent:settings.rewardPercent,state};
  });
}

async function adminAdjustCredit({customerId,currency,amountMinor,reason,actorUserId=null}={}){
  const note=requiredReason(reason),amount=Number(amountMinor),requested=String(currency||'').trim().toUpperCase();
  if(!Number.isSafeInteger(amount)||amount===0)throw new Error('Enter a non-zero credit adjustment amount.');if(!planPricing.CURRENCIES.includes(requested))throw new Error('Choose GBP, USD or EUR for the adjustment.');
  return transaction(async client=>{
    await accounting.lockCustomer(client,customerId);await accounting.ensureHistoricalAllocations(client,customerId,requested);
    const affiliate=await client.query(`SELECT customer_id FROM affiliate_profiles WHERE customer_id=$1`,[customerId]);if(!affiliate.rowCount)throw new Error('Affiliate account not found.');
    if(amount<0){const available=await serviceCreditReservations.availableMinorForClient(client,customerId,requested);if(Math.abs(amount)>available)throw new Error(`This adjustment would remove more ${requested} credit than is currently spendable.`);}
    const referenceId=`admin-affiliate-adjustment:${crypto.randomUUID()}`;
    const inserted=(await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,reference_id,note,metadata) VALUES($1,$2,$3,'adjustment','available',$4,$5,$6::jsonb) RETURNING *`,[customerId,requested,amount,referenceId,`Admin affiliate credit adjustment · ${note}`,JSON.stringify({adjustmentKind:'manual',reason:note,actorUserId})])).rows[0];
    if(amount<0)await accounting.allocateOneDebit(client,inserted);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.affiliate.credit.adjustment','affiliate_credit',$2,$3::jsonb)`,[actorUserId,String(inserted.id),JSON.stringify({customerId,currency:requested,amountMinor:amount,reason:note})]);return{id:inserted.id,customerId,currency:requested,amountMinor:amount};
  });
}

async function reverseReward({redemptionId,paymentIncidentId=null,reason='payment_reversal'}={}){
  if(!redemptionId)return{reversed:false,reason:'missing_redemption'};
  return transaction(async client=>{
    const candidate=await client.query(`SELECT id,customer_id FROM affiliate_credit_ledger WHERE referral_redemption_id=$1 AND entry_type='earned' ORDER BY created_at LIMIT 1`,[redemptionId]);
    if(!candidate.rowCount)return{reversed:false,reason:'no_credit'};
    await accounting.lockCustomer(client,candidate.rows[0].customer_id);
    const earned=await client.query(`SELECT * FROM affiliate_credit_ledger WHERE id=$1 FOR UPDATE`,[candidate.rows[0].id]);
    if(!earned.rowCount)return{reversed:false,reason:'no_credit'};
    const row=earned.rows[0];if(row.state==='void')return{reversed:false,reason:'legacy_void_reward'};
    await accounting.ensureHistoricalAllocations(client,row.customer_id,row.currency);
    const activeReservation=await client.query(`SELECT id FROM affiliate_credit_checkout_reservations
      WHERE customer_id=$1 AND currency=$2 AND state='reserved' AND expires_at>NOW()
      UNION ALL
      SELECT id FROM affiliate_credit_renewal_reservations
      WHERE customer_id=$1 AND currency=$2 AND state IN('reserved','provider_applied')
      LIMIT 1`,[row.customer_id,row.currency]);
    if(activeReservation.rowCount){
      const error=new Error('Affiliate reward reconciliation deferred while service credit is reserved by an open checkout or renewal invoice.');
      error.code='AFFILIATE_CREDIT_RESERVATION_PENDING';
      throw error;
    }
    const metadata=row.metadata&&typeof row.metadata==='object'?row.metadata:{},grossPaidMinor=Math.max(0,Number(metadata.grossPaidMinor||metadata.paidMinor||0));
    if(!grossPaidMinor)return{reversed:false,reason:'missing_paid_basis'};
    const source=await client.query(`SELECT COALESCE(SUM(amount_minor),0)::int granted,
      COALESCE(MAX(CASE WHEN entry_type='adjustment' AND (metadata->>'targetRewardPercent') ~ '^[0-9]+$' THEN (metadata->>'targetRewardPercent')::int END),0)::int top_rate
      FROM affiliate_credit_ledger WHERE amount_minor>0 AND state<>'void' AND (id=$1 OR metadata->>'sourceRewardId'=$1::text)`,[row.id]);
    const totalGranted=Number(source.rows[0]?.granted||0),effectiveRate=Math.max(Number(metadata.rewardPercent||0),Number(source.rows[0]?.top_rate||0));
    const adverse=await refundStateForReward(client,row),netPaidMinor=adverse.chargeback?0:Math.max(0,grossPaidMinor-Math.min(grossPaidMinor,adverse.refundedMinor));
    const targetRewardMinor=netPaidMinor>0?Math.min(totalGranted,Math.max(1,Math.floor(netPaidMinor*effectiveRate/100))):0;
    const requiredReduction=Math.max(0,totalGranted-targetRewardMinor);
    const breakdown=await accounting.allocationBreakdownForReward(client,row.id);
    const existingRecovery=await accounting.recoveryForReward(client,row.id);
    const alreadyAccounted=breakdown.reversed+breakdown.adjusted+Number(existingRecovery.amountMinor||0),delta=Math.max(0,requiredReduction-alreadyAccounted);
    if(delta===0)return{reversed:false,reason:'already_reconciled',amountMinor:0,currency:row.currency,customerId:row.customer_id,remainingRewardMinor:targetRewardMinor,recoverableMinor:Math.max(0,Number(existingRecovery.amountMinor||0)-Number(existingRecovery.recoveredMinor||0))};
    const capacity=await accounting.sourceCapacity(client,row.id),unspent=Math.max(0,capacity-breakdown.total),debitMinor=Math.min(delta,unspent),recoveryMinor=delta-debitMinor;
    const recoverableCapacity=Math.max(0,breakdown.redeemed-Number(existingRecovery.amountMinor||0));
    if(recoveryMinor>recoverableCapacity)throw new Error(`Affiliate recovery invariant violated: ${recoveryMinor} ${row.currency} minor units exceed delivered service-credit value ${recoverableCapacity}.`);
    if(debitMinor>0){
      const state=row.state==='pending'?'pending':'available',referenceId=`affiliate-reversal:${redemptionId}:${paymentIncidentId||crypto.createHash('sha256').update(String(reason)).digest('hex').slice(0,16)}:${requiredReduction}`;
      const inserted=await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,referral_redemption_id,payment_incident_id,available_at,reference_id,note,metadata)
        VALUES($1,$2,$3,'reversed',$4,$5,$6,$7,$8,$9,$10::jsonb) ON CONFLICT(entry_type,reference_id) DO NOTHING RETURNING *`,[row.customer_id,row.currency,-debitMinor,state,redemptionId,paymentIncidentId,row.available_at,referenceId,String(reason).slice(0,200),JSON.stringify({sourceRewardId:String(row.id),grossPaidMinor,netPaidMinor,refundedMinor:adverse.refundedMinor,targetRewardMinor,totalGranted,requiredReduction,reversalMinor:debitMinor})]);
      if(inserted.rowCount)await accounting.allocateOneDebit(client,inserted.rows[0]);
    }
    if(recoveryMinor>0)await accounting.recordRecovery(client,{customerId:row.customer_id,currency:row.currency,sourceRewardId:row.id,amountMinor:recoveryMinor,reason,metadata:{redemptionId,paymentIncidentId,grossPaidMinor,netPaidMinor,targetRewardMinor,requiredReduction}});
    return{reversed:true,amountMinor:debitMinor,currency:row.currency,customerId:row.customer_id,remainingRewardMinor:targetRewardMinor,recoverableMinor:recoveryMinor,netPaidMinor};
  });
}

async function redeemPlan({customerId,planCode,currency}){
  await commerce.assertOpen();await matureDueCredits(customerId);const wanted=cleanCurrency(currency);
  const result=await transaction(async client=>{
    await accounting.lockCustomer(client,customerId);await accounting.ensureHistoricalAllocations(client,customerId,wanted);
    const affiliate=await client.query(`SELECT active FROM affiliate_profiles WHERE customer_id=$1`,[customerId]);if(!affiliate.rows[0]?.active)throw new Error('Enable your affiliate account before using service credit.');
    const plan=(await client.query(`SELECT * FROM plans WHERE code=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND audience IN('direct','both') LIMIT 1`,[String(planCode||'').trim()])).rows[0];if(!plan)throw new Error('That plan is not available.');
    const price=(await client.query(`SELECT * FROM plan_prices WHERE plan_id=$1 AND currency=$2 AND active=TRUE LIMIT 1`,[plan.id,wanted])).rows[0];if(!price)throw new Error(`That plan is not available in ${wanted}.`);
    const cost=Number(price.price_minor||0);if(cost<=0)throw new Error('Free plans do not use affiliate credit.');const available=await serviceCreditReservations.availableMinorForClient(client,customerId,wanted);if(available<cost)throw new Error(`You need ${cost-available} more ${wanted} minor units of service credit for this plan.`);
    const live=await client.query(`WITH live_ids AS (
        SELECT subscription_id FROM effective_customer_entitlements WHERE customer_id=$1
        UNION SELECT subscription_id FROM effective_stremio_entitlements WHERE customer_id=$1
        UNION SELECT subscription_id FROM effective_customer_addons WHERE customer_id=$1
      ) SELECT s.id AS subscription_id,s.plan_id,COALESCE(p.is_addon,FALSE) AS is_addon,COALESCE(p.is_free_tier,FALSE) AS is_free_tier,
          COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') AS service_type
        FROM live_ids e JOIN subscriptions s ON s.id=e.subscription_id JOIN plans p ON p.id=s.plan_id`,[customerId]);
    const conflict=plan.is_addon
      ? live.rows.find(row=>row.is_addon&&String(row.plan_id)===String(plan.id))
      : live.rows.find(row=>!row.is_addon&&!row.is_free_tier&&serviceScope.overlaps(row,plan));
    if(conflict)throw new Error(`You already have active ${serviceScope.label(conflict)} service that overlaps this plan. Use your existing subscription controls before activating another overlapping plan.`);
    await planCapacity.lockAndAssert(client,plan.id,plan.name||'This plan');const starts=new Date(),ends=billingPeriods.addPlanDuration(plan,starts);
    const sub=(await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,price_minor_snapshot,currency_snapshot,plan_name_snapshot,service_type_snapshot) VALUES($1,$2,'active','service_credit',$3,$4,$5,$6,$7,$8) RETURNING id`,[customerId,plan.id,starts,ends,cost,wanted,plan.name,plan.service_type||'jellyfin'])).rows[0];
    const debit=(await client.query(`INSERT INTO affiliate_credit_ledger(customer_id,currency,amount_minor,entry_type,state,applied_subscription_id,reference_id,note,metadata) VALUES($1,$2,$3,'redeemed','available',$4,$5,$6,$7::jsonb) RETURNING *`,[customerId,wanted,-cost,sub.id,`subscription:${sub.id}`,`Redeemed service credit for ${plan.name}`,JSON.stringify({planId:plan.id,planCode:plan.code,planPriceId:price.id,costMinor:cost})])).rows[0];await accounting.allocateOneDebit(client,debit);
    await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('affiliate.credit.redeem','subscription',$1,$2::jsonb)`,[sub.id,JSON.stringify({customerId,planId:plan.id,planCode:plan.code,currency:wanted,costMinor:cost})]);return{subId:sub.id,planId:plan.id,costMinor:cost,currency:wanted,balanceAfter:available-cost};
  });await provisioning.reconcileCustomer(customerId);return result;
}

module.exports={loadSettings,enroll,profile,referralActivity,balances,matureDueCredits,createPendingReward,topUpRewardToCurrentRate,adminAdjustCredit,reverseReward,redeemPlan,cleanCurrency};
