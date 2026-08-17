'use strict';

const {query}=require('../db');
const LIVE_STATUSES=Object.freeze(['active','trialing','past_due','paused']);
const DIRECT_AUDIENCES=new Set(['direct','both']);
const RESELLER_AUDIENCES=new Set(['reseller','both']);
function recurringProvider(row){const source=String(row?.source||''),id=String(row?.provider_subscription_id||'');return(source==='stripe'&&/^sub_/i.test(id))||(source==='paypal'&&/^I-/i.test(id))}
function audienceAllows(plan,channel){const audience=String(plan?.audience||'direct');if(channel==='customer')return DIRECT_AUDIENCES.has(audience);if(channel==='reseller')return RESELLER_AUDIENCES.has(audience);return false}
function assertAudience(plan,channel){if(!audienceAllows(plan,channel))throw new Error(channel==='customer'?'This plan is not available for direct customers.':'This plan is not available through resellers.');return plan}

async function managedResellerEntitlement(customerId,{client=null,includeBlocked=false}={}){
 const db=client||{query};
 const owner=await db.query(`SELECT reseller_id,reseller_managed FROM customers WHERE id=$1`,[customerId]);
 if(!owner.rowCount||!owner.rows[0].reseller_managed||!owner.rows[0].reseller_id)return{managed:false,entitlement:null};
 const result=await db.query(`
   SELECT rt.*,
          NULL::uuid AS subscription_id,
          rt.id AS plan_id,
          'reseller_tier'::text AS entitlement_kind,
          'jellyfin'::text AS service_type,
          'reseller'::text AS audience,
          'month'::text AS billing_interval,
          30::int AS duration_days,
          COALESCE(rs.monthly_price_minor_snapshot,rt.monthly_price_minor) AS price_minor,
          COALESCE(rs.currency_snapshot,rt.currency) AS currency,
          COALESCE(rs.tier_name_snapshot,rt.name) AS contract_plan_name,
          rt.code AS contract_plan_code,
          COALESCE(rs.monthly_price_minor_snapshot,rt.monthly_price_minor) AS contract_price_minor,
          COALESCE(rs.currency_snapshot,rt.currency) AS contract_currency,
          'month'::text AS contract_billing_interval,
          30::int AS contract_duration_days,
          rs.current_period_end AS access_expires_at,
          EXISTS(
            SELECT 1 FROM customer_access_holds h
            WHERE h.customer_id=$1 AND h.released_at IS NULL
          ) AS blocked
   FROM reseller_subscriptions rs
   JOIN reseller_tiers rt ON rt.id=rs.tier_id
   WHERE rs.reseller_id=$2
     AND (
       (rs.status='active' AND rs.current_period_end>NOW())
       OR (
         rs.status='past_due'
         AND GREATEST(COALESCE(rs.grace_until,'epoch'::timestamptz),COALESCE(rs.manual_grace_until,'epoch'::timestamptz))>NOW()
       )
     )
     AND ($3::boolean OR NOT EXISTS(
       SELECT 1 FROM customer_access_holds h
       WHERE h.customer_id=$1 AND h.released_at IS NULL
     ))
   ORDER BY CASE WHEN rs.status='active' THEN 0 ELSE 1 END,rs.current_period_end DESC,rs.created_at DESC
   LIMIT 1
 `,[customerId,owner.rows[0].reseller_id,Boolean(includeBlocked)]);
 return{managed:true,entitlement:result.rows[0]||null};
}

async function effectiveSubscription(customerId,{client=null,includeBlocked=false}={}){
 const managed=await managedResellerEntitlement(customerId,{client,includeBlocked});
 if(managed.managed)return managed.entitlement;
 const db=client||{query};const result=await db.query(`
 SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
        COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
        COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
        COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
        COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
        COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
        COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days,
        e.access_expires_at,e.blocked
 FROM effective_customer_entitlements e
 JOIN subscriptions s ON s.id=e.subscription_id
 JOIN plans p ON p.id=e.plan_id
 WHERE e.customer_id=$1 AND ($2::boolean OR e.blocked=FALSE)
 LIMIT 1
 `,[customerId,Boolean(includeBlocked)]);return result.rows[0]||null}
async function effectiveAddons(customerId,{client=null,includeBlocked=false}={}){const db=client||{query};const result=await db.query(`
 SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
        COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
        COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
        COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
        COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
        COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
        COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days,
        a.access_expires_at,a.blocked
 FROM effective_customer_addons a
 JOIN subscriptions s ON s.id=a.subscription_id
 JOIN plans p ON p.id=a.plan_id
 WHERE a.customer_id=$1 AND ($2::boolean OR a.blocked=FALSE)
 ORDER BY a.access_expires_at DESC,s.created_at DESC
 `,[customerId,Boolean(includeBlocked)]);return result.rows}
async function assertNoOtherLiveRecurring(client,customerId,excludeId=null,targetPlanId=null){
 const base=`s.customer_id=$1 AND s.superseded_by IS NULL AND s.id<>COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND s.source IN('stripe','paypal') AND s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW() AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\') OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%'))`;
 if(!targetPlanId){const result=await client.query(`SELECT s.id FROM subscriptions s WHERE ${base} LIMIT 1 FOR UPDATE`,[customerId,excludeId]);if(result.rowCount)throw new Error('A recurring subscription is already active for this customer. Change or cancel it instead of creating another one.');return;}
 const target=await client.query('SELECT id,is_addon FROM plans WHERE id=$1',[targetPlanId]);if(!target.rowCount)throw new Error('Plan not found.');
 if(target.rows[0].is_addon){const result=await client.query(`SELECT s.id FROM subscriptions s WHERE ${base} AND s.plan_id=$3 LIMIT 1 FOR UPDATE`,[customerId,excludeId,targetPlanId]);if(result.rowCount)throw new Error('This customer already has an active recurring subscription for this add-on.');return;}
 const result=await client.query(`SELECT s.id FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE ${base} AND COALESCE(p.is_addon,FALSE)=FALSE LIMIT 1 FOR UPDATE`,[customerId,excludeId]);if(result.rowCount)throw new Error('A primary recurring subscription is already active for this customer. Change or cancel it instead of creating another primary subscription.');
}
function assertSafeSourceRewrite(existing,targetSource){if(recurringProvider(existing)&&!['stripe','paypal'].includes(String(targetSource||'')))throw new Error('A provider-managed recurring subscription cannot be converted into a manual or reseller subscription. Cancel/change provider billing through the billing workflow first.')}
async function markSuperseded(client,{subscriptionId,replacementId,reason='plan_change'}){await client.query(`UPDATE subscriptions SET superseded_by=$2,replaced_at=NOW(),replacement_reason=$3,updated_at=NOW() WHERE id=$1 AND superseded_by IS NULL`,[subscriptionId,replacementId,String(reason||'').slice(0,200)])}
module.exports={LIVE_STATUSES,recurringProvider,audienceAllows,assertAudience,managedResellerEntitlement,effectiveSubscription,effectiveAddons,assertNoOtherLiveRecurring,assertSafeSourceRewrite,markSuperseded};
