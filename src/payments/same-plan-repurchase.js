'use strict';

// Read-only decisions about buying a plan the customer already holds.
const {query}=require('../db');
const subscriptionState=require('../entitlements/subscription-state');
const accessExtensions=require('./subscription-access-extensions');

const EXTENDABLE_STATUSES=new Set(['active','trialing','past_due','paused','cancelled']);
// Customer-visible refusals. Every one of them happens before money is taken.
const MESSAGES=Object.freeze({
  UNPROTECTED:'A separate one-off purchase would run over the time you still have on this plan. Use Extend on your current plan without a promo code or service credit, or contact support. You have not been charged.',
  UNVERIFIED:'Your current access could not be checked, so nothing was charged. Try again shortly.'
});

function refusal(code){const error=new Error(MESSAGES[code]);error.code=`SAME_PLAN_PURCHASE_${code}`;return error;}
function serviceOf(plan){return String(plan?.service_type||'jellyfin').toLowerCase();}
function accessEndMs(row){return new Date(row?.current_period_end||0).getTime()+Math.max(0,Number(row?.service_extension_days||0))*86400000;}

// Every started row on which the customer still has paid time on this plan, and
// whether a separate one-off purchase of the plan would be queued behind it.
// A renewing agreement is never queued behind: it keeps charging over whatever
// is bought beside it. A renewal that is not being paid is not paid time.
async function assessHolding(customerId,planId,{db=query}={}){
  if(!customerId||!planId)return{current:false,unprotectedIds:[]};
  const result=await db(`
    SELECT s.id,
           (public.prepaid_row_is_recurring(s.source,s.provider_subscription_id,s.billing_mode)
             AND NOT s.cancel_at_period_end AND s.status='active') AS renewing,
           EXISTS(SELECT 1 FROM public.prepaid_paid_time($1) paid WHERE paid.subscription_id=s.id) AS queue_protected
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
     WHERE s.customer_id=$1 AND s.plan_id=$2
       AND s.superseded_by IS NULL AND s.refund_terminated_at IS NULL
       AND COALESCE(p.is_addon,FALSE)=FALSE AND COALESCE(p.is_free_tier,FALSE)=FALSE
       AND p.price_minor>0 AND p.billing_interval<>'trial'
       AND s.starts_at<=NOW()
       AND (
         (s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
         OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
             AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
       )
       AND NOT (public.prepaid_row_is_recurring(s.source,s.provider_subscription_id,s.billing_mode)
                AND s.status IN('past_due','paused','trialing'))
  `,[customerId,planId]);
  const rows=result.rows||[];
  return{
    current:rows.length>0,
    unprotectedIds:rows.filter(row=>row.renewing||!row.queue_protected).map(row=>String(row.id))
  };
}

// The last word before money: a direct one-off purchase may not be created over
// time it cannot be queued behind. Extensions add to that time and are allowed.
async function assertPurchaseKeepsPaidTime({customerId,planId,kind},{db=query}={}){
  if(kind!=='direct_plan')return;
  const holding=await assessHolding(customerId,planId,{db});
  if(holding.unprotectedIds.length)throw refusal('UNPROTECTED');
}

// The customer's current paid entitlement on this plan's lane, only when it is
// this exact plan and still has paid time that an extension could be added to.
async function currentPaidSubscription(customerId,plan,{includeBlocked=false}={}){
  if(!customerId||!plan?.id)return null;
  const service=serviceOf(plan);
  let row=null;
  if(service==='stremio')row=await subscriptionState.effectiveStremioSubscription(customerId,{includeBlocked});
  else if(service==='emby')row=await subscriptionState.effectiveEmbySubscription(customerId,{includeBlocked});
  else if(service==='jellyfin'||service==='bundle')row=await subscriptionState.effectiveSubscription(customerId,{includeBlocked});
  if(!row||String(row.plan_id)!==String(plan.id))return null;
  if(row.blocked||row.is_free_tier||row.is_addon||Number(row.price_minor||0)<=0||String(row.billing_interval||'')==='trial')return null;
  const end=accessEndMs(row);
  if(!EXTENDABLE_STATUSES.has(String(row.status||''))||!Number.isFinite(end)||end<=Date.now())return null;
  return row;
}

// The subscription a one-off repurchase could be added to, or null when an
// extension cannot be sold right now.
async function extensionTarget(customerId,plan){
  const current=await currentPaidSubscription(customerId,plan,{includeBlocked:true});
  if(!current)return null;
  const subscriptionId=String(current.subscription_id||current.id),service=serviceOf(plan);
  const result=await query(`
    SELECT
      EXISTS(
        SELECT 1 FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        WHERE s.customer_id=$1 AND s.superseded_by IS NULL AND s.refund_terminated_at IS NULL
          AND COALESCE(p.is_addon,FALSE)=FALSE AND s.starts_at>NOW()
          AND s.status IN('active','trialing','past_due','paused','cancelled')
          AND public.prepaid_lanes_overlap(COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin'),$3)
      ) AS has_queued,
      EXISTS(
        SELECT 1 FROM customer_plan_changes pc
        WHERE pc.customer_id=$1 AND pc.current_subscription_id::text=$2 AND pc.state IN('pending','awaiting_checkout')
      ) OR EXISTS(
        SELECT 1 FROM provider_operations po
        WHERE po.scope='customer' AND po.owner_id=$1 AND po.operation_type='plan_change_immediate'
          AND COALESCE(po.local_reference,'')=$2
          AND (po.state IN('planned','provider_applied','local_applied') OR (po.state='failed' AND po.manual_review_required=TRUE))
      ) AS change_open
  `,[customerId,subscriptionId,service]);
  const facts=result.rows[0]||{};
  if(facts.has_queued||facts.change_open)return null;
  let days=null;
  try{days=accessExtensions.purchasedDays({billingInterval:plan.billing_interval,durationDays:plan.duration_days},new Date(accessEndMs(current)));}
  catch(_){return null;}
  if(Number(current.service_extension_days||0)+days>3650)return null;
  return{subscriptionId};
}

module.exports={MESSAGES,refusal,assessHolding,assertPurchaseKeepsPaidTime,currentPaidSubscription,extensionTarget};
