'use strict';

// Historical repair is deliberately narrower than the live settlement path:
// a terminal base, exact completed checkout evidence for every surviving
// extension, and no unresolved payment loss. No provider charges or refunds.
const {query,transaction}=require('../db');
const financialState=require('./provider-financial-state');
const ELIGIBLE=`
 s.refund_terminated_at IS NOT NULL AND s.superseded_by IS NULL
 AND NOT EXISTS(SELECT 1 FROM subscriptions recovered WHERE recovered.extension_recovery_of=s.id)
 AND EXISTS(SELECT 1 FROM subscription_access_extensions e
   WHERE e.subscription_id=s.id AND e.status='active' AND e.applied_days>0)
 AND GREATEST(s.starts_at,LEAST(s.current_period_end,s.refund_terminated_at))
   +make_interval(days=>COALESCE((SELECT SUM(e.applied_days)::int FROM subscription_access_extensions e
     WHERE e.subscription_id=s.id AND e.status='active' AND e.applied_days>0),0))>NOW()
 AND NOT EXISTS(
   SELECT 1 FROM subscription_access_extensions e
   LEFT JOIN billing_checkout_intents i ON i.id=e.checkout_intent_id
   WHERE e.subscription_id=s.id AND e.status='active' AND e.applied_days>0
   AND (
     e.customer_id IS DISTINCT FROM s.customer_id OR e.plan_id IS DISTINCT FROM s.plan_id
     OR i.id IS NULL OR i.state IS DISTINCT FROM 'completed' OR i.scope IS DISTINCT FROM 'customer'
     OR i.customer_id IS DISTINCT FROM e.customer_id OR i.plan_id IS DISTINCT FROM e.plan_id
     OR i.provider IS DISTINCT FROM e.provider OR i.checkout_mode IS DISTINCT FROM 'payment'
     OR i.provider_checkout_id IS NULL
     OR i.commercial_snapshot->>'kind' IS DISTINCT FROM 'subscription_extension'
     OR i.commercial_snapshot->>'extensionSubscriptionId' IS DISTINCT FROM s.id::text
     OR (i.commercial_snapshot||jsonb_build_object('checkoutIntentId',i.id)) IS DISTINCT FROM e.commercial_snapshot
     OR CASE WHEN COALESCE(i.commercial_snapshot->>'discountedMinor','')~'^[0-9]{1,10}$'
       THEN (i.commercial_snapshot->>'discountedMinor')::bigint<=0 ELSE TRUE END
     OR EXISTS(SELECT 1 FROM payment_incidents pi WHERE pi.provider=e.provider
       AND pi.provider_subscription_id=e.provider_payment_id
       AND pi.incident_type IN ('refund','chargeback','dispute'))
     OR ${financialState.extensionAdverseEvidenceSql()}
   )
 )`;
async function candidates({limit=25,db=query}={}){
 const bounded=Math.max(1,Math.min(100,Number(limit)||25));
 return (await db(`SELECT s.id,s.customer_id FROM subscriptions s WHERE ${ELIGIBLE}
   AND NOT EXISTS(SELECT 1 FROM audit_log a WHERE a.entity_type='subscription' AND a.entity_id=s.id::text
     AND a.action='subscription.access_extension.historical_repair_deferred'
     AND a.created_at>NOW()-INTERVAL '1 day')
   ORDER BY s.refund_terminated_at DESC,s.id LIMIT $1`,[bounded])).rows;
}
async function recoverOne(client,{id,customer_id:customerId}){
 await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
 await client.query('SELECT id FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[id,customerId]);
 // The refund owner shares the customer lock; recheck the full evidence
 // after acquiring it, rather than trusting the earlier candidate scan.
 const verified=await client.query(`SELECT s.id FROM subscriptions s WHERE s.id=$1 AND s.customer_id=$2 AND ${ELIGIBLE}`,[id,customerId]);
 if(!verified.rowCount)return {status:'stale'};
 const recovered=(await client.query('SELECT public.recover_independent_paid_extensions($1) AS id',[id])).rows[0]?.id;
 if(recovered)return {status:'recovered',subscriptionId:recovered};
 await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
   VALUES('subscription.access_extension.historical_repair_deferred','subscription',$1,$2::jsonb)`,
   [id,JSON.stringify({customerId,reason:'existing_access_or_allowance_requires_review'})]);
 return {status:'deferred'};
}
async function run({limit=25,db=query,tx=transaction}={}){
 const rows=await candidates({limit,db});
 const summary={processed:0,recovered:0,stale:0,deferred:0,failed:0,errors:[]};
 for(const row of rows){
   summary.processed++;
   try{const result=await tx(client=>recoverOne(client,row));summary[result.status]++;}
   catch(error){summary.failed++;summary.errors.push({subscriptionId:row.id,error:String(error.message||error).slice(0,500)});}
 }
 return summary;
}
module.exports={candidates,recoverOne,run};
