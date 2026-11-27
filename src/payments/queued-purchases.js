'use strict';

const {query}=require('../db');

const RESUME_BLOCKED='Automatic renewal cannot be resumed while a separately paid purchase is waiting to start after this period. Nothing was charged.';

// TRUE when a paid purchase is waiting to start on the same lane as this
// agreement. Renewing now would charge again over time already paid for.
async function hasPurchaseQueuedBehind(subscriptionId,{db=query}={}){
  const result=await db(`
    SELECT EXISTS(
      SELECT 1 FROM subscriptions renewing
      JOIN plans renewing_plan ON renewing_plan.id=renewing.plan_id
      JOIN subscriptions s ON s.customer_id=renewing.customer_id AND s.id<>renewing.id
      JOIN plans p ON p.id=s.plan_id
      WHERE renewing.id=$1 AND COALESCE(renewing_plan.is_addon,FALSE)=FALSE
        AND s.superseded_by IS NULL AND s.refund_terminated_at IS NULL AND COALESCE(p.is_addon,FALSE)=FALSE
        AND s.starts_at>NOW() AND s.status IN('active','trialing','past_due','paused')
        AND public.prepaid_row_is_queueable(s.source,s.provider_subscription_id,s.billing_mode,s.commercial_snapshot)
        AND public.prepaid_lanes_overlap(
          COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin'),
          COALESCE(NULLIF(renewing.service_type_snapshot,''),renewing_plan.service_type,'jellyfin'))
    ) AS queued
  `,[subscriptionId]);
  return Boolean(result.rows[0]?.queued);
}

// Purchases queued behind a subscription's paid end. Whoever changes that end
// moves them in the same transaction. Lock order is always the customer, then
// the subscription.
async function lockQueueOwner(client,customerId){
  await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
}
// Read as text: a JavaScript Date would drop the microseconds that make a queued
// start equal to this end.
async function accessEndBefore(client,subscriptionId){
  const result=await client.query('SELECT current_period_end::text AS period_end,service_extension_days FROM subscriptions WHERE id=$1 FOR UPDATE',[subscriptionId]);
  return result.rows[0]||null;
}
async function moveQueuedPurchases(client,subscriptionId,before){
  if(!before)return;
  await client.query('SELECT public.shift_prepaid_queue_after_end_change($1,$2,$3::timestamptz)',
    [subscriptionId,Math.max(0,Number(before.service_extension_days||0)),before.period_end||null]);
}

module.exports={RESUME_BLOCKED,hasPurchaseQueuedBehind,lockQueueOwner,accessEndBefore,moveQueuedPurchases};
