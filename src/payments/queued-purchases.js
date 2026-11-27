'use strict';

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

module.exports={lockQueueOwner,accessEndBefore,moveQueuedPurchases};
