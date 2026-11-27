'use strict';

// Read-only decisions about buying a plan the customer already holds.
const {query}=require('../db');
const subscriptionState=require('../entitlements/subscription-state');
const accessExtensions=require('./subscription-access-extensions');

const EXTENDABLE_STATUSES=new Set(['active','trialing','past_due','paused','cancelled']);

function serviceOf(plan){return String(plan?.service_type||'jellyfin').toLowerCase();}
function accessEndMs(row){return new Date(row?.current_period_end||0).getTime()+Math.max(0,Number(row?.service_extension_days||0))*86400000;}

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

// Facts that decide whether a direct one-off repurchase of the current plan can
// simply be bought (and queued) or has to become an extension of the current row.
async function assessRepurchase(customerId,plan){
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
      ) AS change_open,
      EXISTS(
        SELECT 1 FROM subscriptions s
        WHERE s.id::text=$2 AND (
          SELECT MAX(paid.access_end) FROM public.prepaid_paid_time($1) paid
          WHERE public.prepaid_lanes_overlap(paid.service_type,$3)
        )>=s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval)
      ) AS queue_protects
  `,[customerId,subscriptionId,service]);
  const facts=result.rows[0]||{};
  if(facts.has_queued||facts.change_open)return null;
  let days=null;
  try{days=accessExtensions.purchasedDays({billingInterval:plan.billing_interval,durationDays:plan.duration_days},new Date(accessEndMs(current)));}
  catch(_){return null;}
  if(Number(current.service_extension_days||0)+days>3650)return null;
  return{subscriptionId,queueProtects:Boolean(facts.queue_protects)};
}

module.exports={currentPaidSubscription,assessRepurchase};
