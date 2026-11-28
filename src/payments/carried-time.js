'use strict';

// A payment always adds time: paid time that a new auto-renewing agreement
// would otherwise run over is moved onto it. The database owns every movement
// (see the carried paid time migration); this module decides when to ask.
const {query,transaction}=require('../db');
const billingMode=require('./subscription-billing-mode');
const {INCIDENT_PROVIDERS}=require('./provider-registry');

const MAX_EXTENSION_DAYS=3650;
// Customer-visible refusals. Every one of them happens before money is taken.
const MESSAGES=Object.freeze({
  LIFETIME:'You already have access like this that does not expire, so there is no time an auto-renewing plan could add. You have not been charged.',
  LIMIT:'The time you already have cannot all be added to a new plan because it exceeds the longest supported paid period. Contact support. You have not been charged.',
  UNVERIFIED:'Your current access could not be checked, so nothing was charged. Try again shortly.'
});
// Lock and serialization conflicts pass: retrying the whole activation is
// better than activating without the carry.
const RETRYABLE=new Set(['40001','40P01','55P03']);
const ENDED=new Set(['cancelled','expired']);
// A renewal failure is recognised from the period it left unpaid: that period
// starts no earlier than this long before the delinquency hold was raised.
const UNPAID_PERIOD_GRACE_MS=7*86400000;
const PERIOD_MONTHS=Object.freeze({month:1,'6_months':6,year:12});
// Audit markers: an agreement whose first payment is not yet confirmed.
const AWAITING_FIRST_PAYMENT='subscription.paid_time.awaiting_first_payment';
const FIRST_PAYMENT_CONFIRMED='subscription.paid_time.first_payment_confirmed';

function refusal(code){const error=new Error(MESSAGES[code]);error.code=`CARRIED_TIME_${code}`;return error;}

function precheckRefusal(row){
  if(row?.lifetime)return'LIFETIME';
  return Number(row?.total_days||0)>MAX_EXTENSION_DAYS?'LIMIT':null;
}

// Before an auto-renewing checkout is created: refuse when the time the customer
// holds with identical access could not be added to it. db runs inside the
// checkout transaction.
async function assertCarryPossible({customerId,planId,snapshot},{db=query}={}){
  let row;
  try{
    row=(await db('SELECT lifetime,total_days FROM public.carried_time_precheck($1,$2,$3::jsonb)',
      [customerId,planId,JSON.stringify(snapshot||{})])).rows[0];
  }catch(error){
    console.warn('Current paid time could not be checked before an auto-renewing checkout:',error.message);
    throw refusal('UNVERIFIED');
  }
  const code=precheckRefusal(row);
  if(code)throw refusal(code);
}

// Runs inside the activation transaction, after the receiving row exists. Money
// has been taken, so a failure here never fails the activation: the sources stay
// exactly as they were and an operator is told.
async function carryOnActivation(client,row){
  if(!row||String(row.status||'')!=='active'||!billingMode.isRecurring(row))return{row,problem:null};
  await client.query('SAVEPOINT carried_time');
  try{
    const result=(await client.query('SELECT public.carry_all_paid_time($1) AS result',[row.id])).rows[0]?.result||null;
    let updated=row;
    // A fully covered source adds no days but is still replaced and may hand
    // over its server placement.
    if(Number(result?.days||0)>0||result?.carried?.length){
      updated=(await client.query('SELECT * FROM subscriptions WHERE id=$1',[row.id])).rows[0]||row;
    }
    await client.query('RELEASE SAVEPOINT carried_time');
    return{row:updated,problem:carryProblem(result)};
  }catch(error){
    if(RETRYABLE.has(error?.code))throw error;
    await client.query('ROLLBACK TO SAVEPOINT carried_time');
    return{row,problem:{reason:'carried_time_failed',detail:String(error?.message||error).slice(0,500)}};
  }
}

function carryProblem(result){
  if(result?.ineligible)return{reason:'carried_time_receiving_period_ended',detail:'The new plan\'s recorded paid period had already ended, so no remaining time was added to it.'};
  const overLimit=(result?.skipped||[]).filter(item=>item.reason==='over_limit');
  return overLimit.length?{reason:'carried_time_over_limit',detail:`Not carried: ${overLimit.map(item=>item.subscriptionId).join(', ')}`}:null;
}

const OPERATOR_ACTIONS=Object.freeze({
  carried_time_failed:'A new auto-renewing plan was paid for but the remaining time could not be added to it. Check the customer\'s plans and add the remaining days to the new plan.',
  carried_time_receiving_period_ended:'A new auto-renewing plan was confirmed but its recorded paid period had already ended, so the remaining time was not added. Check the provider period and add the remaining days to the new plan.',
  carried_time_over_limit:'Some remaining time exceeds the longest supported paid period and was not added to the new plan. It is still on the older plan row.',
  carried_time_owed_after_renewal_loss:'A later renewal payment was reversed and that plan has ended. Days carried from earlier payments are still owed: nothing was granted automatically. Add them to the customer or refund them.'
});

// An open item in payment incidents for a person to act on. Never changes access.
async function recordOperatorIncident({customerId,subscription,reason,detail=null},{db=query}={}){
  const provider=String(subscription?.source||'').toLowerCase();
  if(!INCIDENT_PROVIDERS.includes(provider)||!subscription?.id)return false;
  const eventId=`${reason}:${subscription.id}`;
  await db(`
    INSERT INTO payment_incidents(
      provider,provider_event_id,provider_case_id,incident_type,incident_status,
      scope,customer_id,provider_subscription_id,access_action,metadata
    ) VALUES($1,$2,$2,'checkout_completion','open','direct',$3,$4,'preserve',$5::jsonb)
    ON CONFLICT(provider,provider_event_id,incident_type) DO NOTHING
  `,[provider,eventId,customerId||subscription.customer_id,subscription.provider_subscription_id||null,JSON.stringify({
    reason,subscriptionId:subscription.id,operatorAction:OPERATOR_ACTIONS[reason]||null,detail
  })]);
  return true;
}

// After commit. A failure to record is logged; it must not fail the payment.
async function reportProblem(customerId,subscription,problem){
  if(!problem)return;
  console.error('Carried paid time needs operator attention:',{customerId,subscriptionId:subscription?.id,reason:problem.reason});
  try{await recordOperatorIncident({customerId,subscription,reason:problem.reason,detail:problem.detail});}
  catch(error){console.error('Carried paid time incident could not be recorded:',error.message);}
}

// An auto-renewing row created before its first payment is confirmed. The time
// held is added when it first becomes active, however it gets there.
async function markAwaitingFirstPayment(client,row){
  if(!row?.id||String(row.status||'')==='active'||!billingMode.isRecurring(row))return false;
  await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES($1,'subscription',$2,$3::jsonb)`,
    [AWAITING_FIRST_PAYMENT,String(row.id),JSON.stringify({customerId:row.customer_id,status:row.status})]);
  return true;
}

// Whether this transition to active confirms a first payment. An approved
// agreement (trialing) always does. Otherwise only a row marked when it was
// created and not yet confirmed: a renewal recovering on an older agreement must
// not move time it never carried (past purchases are repaired separately).
async function firstPaymentPending(client,prior){
  if(!prior?.id||String(prior.status||'')==='active')return false;
  if(prior.status==='trialing')return true;
  const result=await client.query(`
    SELECT 1 FROM audit_log a
     WHERE a.entity_type='subscription' AND a.entity_id=$1 AND a.action=$2
       AND NOT EXISTS(SELECT 1 FROM audit_log c WHERE c.entity_type='subscription' AND c.entity_id=$1 AND c.action=$3)
     LIMIT 1
  `,[String(prior.id),AWAITING_FIRST_PAYMENT,FIRST_PAYMENT_CONFIRMED]);
  return Boolean(result.rowCount);
}

// The carry itself happens at most once per receiving row (the ledger).
async function carryOnFirstPayment(client,row){
  const outcome=await carryOnActivation(client,row);
  await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES($1,'subscription',$2,$3::jsonb)`,
    [FIRST_PAYMENT_CONFIRMED,String(row.id),JSON.stringify({customerId:row.customer_id})]);
  return outcome;
}

// The receiving row's payment is being taken back: 'returned', 'owed' or 'none'.
async function returnToSources(client,subscriptionId,reason='first_payment_lost'){
  const result=await client.query('SELECT public.return_carried_paid_time($1,$2) AS outcome',[subscriptionId,reason]);
  return result.rows[0]?.outcome||'none';
}
function owedProblem(outcome){return outcome==='owed'?{reason:'carried_time_owed_after_renewal_loss'}:null;}

// A carried source's own payment was lost. Returns whether anything was carried
// from it. Safe to repeat.
async function reverseSource(client,subscriptionId,customerId,reason='source_payment_lost'){
  const result=await client.query(`
    SELECT public.reverse_carried_paid_time(s.id,$3) AS removed
      FROM subscriptions s WHERE s.id=$1 AND s.customer_id=$2
  `,[subscriptionId,customerId,reason]);
  const removed=result.rows[0]?.removed;
  return removed!==null&&removed!==undefined;
}

// Take exactly the refunded span of a carried source off whatever holds it.
async function reduceSource(client,subscriptionId,removedSeconds,{basePayment,reason}){
  const result=await client.query('SELECT public.reduce_carried_paid_time($1,$2::numeric,$3,$4) AS removed',
    [subscriptionId,removedSeconds,Boolean(basePayment),reason]);
  return Number(result.rows[0]?.removed||0);
}

// The rows now holding time that came from this source.
async function holdersOf(sourceId,{db=query}={}){
  const result=await db(`
    WITH RECURSIVE chain(id,depth) AS (
      SELECT target_subscription_id,1 FROM subscription_time_carryovers WHERE source_subscription_id=$1
      UNION ALL
      SELECT l.target_subscription_id,chain.depth+1
        FROM subscription_time_carryovers l JOIN chain ON l.source_subscription_id=chain.id
       WHERE chain.depth<100
    )
    SELECT DISTINCT id FROM chain
  `,[sourceId]);
  return result.rows.map(row=>row.id);
}

// A confirmed full refund or lost chargeback may name a payment whose time has
// been carried: its row is replaced, so the ordinary termination cannot see it.
// The database trigger reverses one-off payments when the incident is inserted;
// this repeats that safely and covers ended auto-renewing sources. Returns the
// affected subscription ids so the caller can re-run extension arithmetic and
// reconcile access.
async function settleSourcePaymentLoss({provider,reference,customerId,decide,reason}){
  const sources=await query(`
    SELECT s.id,s.source,s.billing_mode,s.current_period_end,s.duration_days_snapshot
      FROM subscriptions s
     WHERE LOWER(BTRIM(COALESCE(s.source,'')))=$1
       AND BTRIM(COALESCE(s.provider_subscription_id,''))=$2
       AND s.customer_id=$3
       AND s.superseded_by IS NOT NULL
       AND EXISTS(SELECT 1 FROM subscription_time_carryovers l WHERE l.source_subscription_id=s.id AND l.status IN ('active','reversed'))
  `,[provider,reference,customerId]);
  const holders=[];
  for(const row of sources.rows){
    if(!await decide(row))continue;
    await transaction(client=>reverseSource(client,row.id,customerId,reason));
    holders.push(...await holdersOf(row.id));
  }
  return[...new Set(holders)];
}

function times(values){return values.filter(Boolean).map(value=>new Date(value).getTime()).filter(Number.isFinite);}
function earliest(values,fallback){const list=times(values);return list.length?new Date(Math.min(...list)):fallback;}
// Where the period ending at `end` began, from the row's contract.
function periodStart(end,row){
  const start=new Date(end),months=PERIOD_MONTHS[String(row?.billing_interval_snapshot||'').toLowerCase()];
  if(months)start.setUTCMonth(start.getUTCMonth()-months);
  else start.setTime(start.getTime()-Math.max(1,Number(row?.duration_days_snapshot)||30)*86400000);
  return start;
}

// A renewal that was never paid must not become paid time when the agreement is
// then ended: the provider's period end is already the unpaid one, and prepaid
// days would be added after it. Protect both carried and separately purchased
// extension time. Whatever
// the status in between (past due, suspended), an open delinquency hold for the
// agreement ends the paid period when the hold was raised, but only when there
// is evidence of a failed payment AND the period being cut began around or after
// that moment. A period that started well before it was paid for (a suspension
// or a failed one-off charge part way through) is never shortened. Returns the
// end to store.
async function paidEndWhenAgreementEnds(client,{prior,status,periodEnd,provider,providerSubscriptionId}){
  if(!prior||!ENDED.has(status))return periodEnd;
  const prepaid=await client.query(`
    SELECT 1 FROM subscription_time_carryovers WHERE target_subscription_id=$1 AND status='active'
    UNION ALL
    SELECT 1 FROM subscription_access_extensions WHERE subscription_id=$1 AND status='active' AND applied_days>0
    LIMIT 1
  `,[prior.id]);
  if(!prepaid.rowCount)return periodEnd;
  // Once ended, a later delivery cannot move the end forward again.
  const unchanged=ENDED.has(prior.status)?earliest([periodEnd,prior.current_period_end],periodEnd):periodEnd;
  const hold=(await client.query(`
    SELECT h.created_at,
           (COALESCE(h.metadata->>'unpaid','false')='true' OR EXISTS(
             SELECT 1 FROM payment_incidents pi
              WHERE pi.provider=$3 AND pi.provider_subscription_id=$4 AND pi.incident_type='failed_renewal'
                AND pi.created_at>=h.created_at-INTERVAL '7 days'
           )) AS failed_payment
      FROM customer_access_holds h
     WHERE h.customer_id=$1 AND h.hold_type='payment_delinquency' AND h.source_key=$2 AND h.released_at IS NULL
     LIMIT 1
  `,[prior.customer_id,`${provider}:${providerSubscriptionId}`,provider,providerSubscriptionId])).rows[0];
  if(!hold||!(prior.status==='past_due'||hold.failed_payment))return unchanged;
  const ends=times([periodEnd,prior.current_period_end]);
  if(!ends.length)return unchanged;
  const raised=new Date(hold.created_at).getTime();
  if(periodStart(Math.max(...ends),prior).getTime()<raised-UNPAID_PERIOD_GRACE_MS)return unchanged;
  return earliest([periodEnd,prior.current_period_end,hold.created_at],unchanged);
}

module.exports={
  MAX_EXTENSION_DAYS,MESSAGES,refusal,precheckRefusal,assertCarryPossible,carryOnActivation,carryProblem,
  recordOperatorIncident,reportProblem,returnToSources,owedProblem,reverseSource,reduceSource,holdersOf,
  settleSourcePaymentLoss,paidEndWhenAgreementEnds,markAwaitingFirstPayment,firstPaymentPending,carryOnFirstPayment
};
