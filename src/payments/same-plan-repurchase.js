'use strict';

// Read-only decisions about buying a plan the customer already holds.
const {query}=require('../db');
const subscriptionState=require('../entitlements/subscription-state');
const accessExtensions=require('./subscription-access-extensions');

const EXTENDABLE_STATUSES=new Set(['active','trialing','past_due','paused','cancelled']);
// Customer-visible refusals. Every one of them happens before money is taken.
const MESSAGES=Object.freeze({
  UNPROTECTED:'A separate one-off purchase would run over the time you still have on this plan. Use Extend on your current plan without a promo code or service credit, or contact support. You have not been charged.',
  LIFETIME:'Your access to this plan does not expire, so there is nothing more to buy. You have not been charged.',
  UNVERIFIED:'Your current access could not be checked, so nothing was charged. Try again shortly.'
});

function refusal(code){const error=new Error(MESSAGES[code]);error.code=`SAME_PLAN_PURCHASE_${code}`;return error;}
function serviceOf(plan){return String(plan?.service_type||'jellyfin').toLowerCase();}
function accessEndMs(row){return new Date(row?.current_period_end||0).getTime()+Math.max(0,Number(row?.service_extension_days||0))*86400000;}
// Permanent Access, or an end twenty or more years away.
function lifetimeAccess(row){
  if(row?.permanent_access||String(row?.access_expires_at)==='Infinity'||String(row?.access_expires_at)==='infinity')return true;
  const horizon=new Date();horizon.setUTCFullYear(horizon.getUTCFullYear()+20);
  return new Date(row?.current_period_end||0).getTime()>=horizon.getTime();
}

// Every started row on which the customer still has paid time on this plan, and
// whether a separate one-off purchase of the plan would be queued behind it.
// A renewing agreement is never queued behind: it keeps charging over whatever
// is bought beside it. A renewal that is not being paid is not paid time.
async function assessHolding(customerId,planId,{db=query}={}){
  if(!customerId||!planId)return{current:false,lifetime:false,unprotectedIds:[]};
  const result=await db(`
    SELECT s.id,
           (public.prepaid_row_is_recurring(s.source,s.provider_subscription_id,s.billing_mode)
             AND NOT s.cancel_at_period_end AND s.status='active') AS renewing,
           EXISTS(SELECT 1 FROM public.prepaid_paid_time($1) paid WHERE paid.subscription_id=s.id) AS queue_protected,
           (s.current_period_end>=NOW()+INTERVAL '20 years' OR o.subscription_id IS NOT NULL) AS lifetime
      FROM subscriptions s
      JOIN plans p ON p.id=s.plan_id
      LEFT JOIN customer_entitlement_overrides o
        ON o.customer_id=s.customer_id AND o.subscription_id=s.id AND o.permanent_access=TRUE AND o.revoked_at IS NULL
     WHERE s.customer_id=$1 AND s.plan_id=$2
       AND s.superseded_by IS NULL AND s.refund_terminated_at IS NULL
       AND COALESCE(p.is_addon,FALSE)=FALSE AND COALESCE(p.is_free_tier,FALSE)=FALSE
       AND p.price_minor>0 AND p.billing_interval<>'trial'
       AND s.starts_at<=NOW()
       AND (
         o.subscription_id IS NOT NULL
         OR (s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
         OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
             AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
       )
       AND NOT (public.prepaid_row_is_recurring(s.source,s.provider_subscription_id,s.billing_mode)
                AND s.status IN('past_due','paused','trialing'))
  `,[customerId,planId]);
  const rows=result.rows||[];
  return{
    current:rows.length>0,
    lifetime:rows.some(row=>row.lifetime),
    unprotectedIds:rows.filter(row=>!row.lifetime&&(row.renewing||!row.queue_protected)).map(row=>String(row.id))
  };
}

// Only for when the assessment itself failed: does the buyer have anything to
// lose? Plain SQL without the paid-time functions, whose absence is a likely
// reason for that failure. A direct purchase is refused when there is live paid
// time on this plan, an extension only when that access never ends, and anybody
// else is not refused. If even this cannot be answered, nothing is sold.
async function assertNothingToProtect(customerId,planId,kind,{db=query}={}){
  let rows;
  try{
    rows=(await db(`
      SELECT (s.current_period_end>=NOW()+INTERVAL '20 years' OR o.subscription_id IS NOT NULL) AS lifetime
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        LEFT JOIN customer_entitlement_overrides o
          ON o.customer_id=s.customer_id AND o.subscription_id=s.id AND o.permanent_access=TRUE AND o.revoked_at IS NULL
       WHERE s.customer_id=$1 AND s.plan_id=$2
         AND s.superseded_by IS NULL AND s.refund_terminated_at IS NULL
         AND COALESCE(p.is_addon,FALSE)=FALSE AND COALESCE(p.is_free_tier,FALSE)=FALSE
         AND p.price_minor>0 AND p.billing_interval<>'trial'
         AND s.starts_at<=NOW()
         AND (
           o.subscription_id IS NOT NULL
           OR (s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW())
           OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
               AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW())
         )
         -- A renewal that is not being paid is not paid time.
         AND NOT (
           s.status IN('past_due','paused','trialing')
           AND COALESCE(
             (s.source IN ('stripe','paypal') AND s.billing_mode='subscription')
             OR (s.source='stripe' AND COALESCE(s.provider_subscription_id,'') ~* '^sub_')
             OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') ~* '^I-')
           ,FALSE)
         )
    `,[customerId,planId])).rows;
  }catch(error){
    console.warn('Current paid time could not be checked:',error.message);
    throw refusal('UNVERIFIED');
  }
  if(kind==='direct_plan'?rows.length:rows.some(row=>row.lifetime))throw refusal('UNVERIFIED');
}

// The last word before money: a direct one-off purchase may not be created over
// time it cannot be queued behind. Extensions add to that time and are allowed.
// Neither buys anything for somebody whose access to the plan never ends.
// transactional: db runs inside an open transaction, which a failed statement
// would otherwise leave unusable for the checkout that may still go ahead.
async function assertPurchaseKeepsPaidTime({customerId,planId,kind},{db=query,transactional=false}={}){
  if(kind!=='direct_plan'&&kind!=='subscription_extension')return;
  let holding;
  try{
    if(transactional)await db('SAVEPOINT paid_time_check');
    holding=await assessHolding(customerId,planId,{db});
    if(transactional)await db('RELEASE SAVEPOINT paid_time_check');
  }catch(error){
    console.warn('Current access could not be assessed before checkout:',error.message);
    if(transactional){
      try{await db('ROLLBACK TO SAVEPOINT paid_time_check');}
      catch(_){throw refusal('UNVERIFIED');}
    }
    await assertNothingToProtect(customerId,planId,kind,{db});
    return;
  }
  if(holding.lifetime)throw refusal('LIFETIME');
  if(kind==='direct_plan'&&holding.unprotectedIds.length)throw refusal('UNPROTECTED');
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
  if(row.blocked||row.is_free_tier||row.is_addon||Number(row.price_minor||0)<=0||String(row.billing_interval||'')==='trial'||lifetimeAccess(row))return null;
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

module.exports={MESSAGES,refusal,assessHolding,assertNothingToProtect,assertPurchaseKeepsPaidTime,currentPaidSubscription,extensionTarget};
