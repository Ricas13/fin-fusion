'use strict';

const {query}=require('../db');
const serviceScope=require('./service-scope');
const billingMode=require('../payments/subscription-billing-mode');
const LIVE_STATUSES=Object.freeze(['active','trialing','past_due','paused']);
const DIRECT_AUDIENCES=new Set(['direct']);
function recurringProvider(row){return billingMode.isRecurring(row)}
function audienceAllows(plan,channel){const audience=String(plan?.audience||'direct');if(channel==='customer')return DIRECT_AUDIENCES.has(audience);return false}
function assertAudience(plan,channel){if(!audienceAllows(plan,channel))throw new Error('This plan is not available for direct customers.');return plan}

async function effectiveSubscription(customerId,{client=null,includeBlocked=false}={}){
 const db=client||{query};const result=await db.query(`
 SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
        COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
        COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
        COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
        COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
        COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
        COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days,
        CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
             THEN 'infinity'::timestamptz
             ELSE s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval)
        END AS access_expires_at,
        public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
 FROM subscriptions s
 JOIN plans p ON p.id=s.plan_id
 LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
 WHERE s.customer_id=$1
   AND COALESCE(p.is_addon,FALSE)=FALSE
   AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
   AND s.superseded_by IS NULL
   AND s.starts_at<=NOW()
   AND (
      (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
      OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN ('active','trialing','past_due','paused','cancelled','expired') AND (s.current_period_end+((s.service_extension_days||' days')::interval))>NOW())
   )
   AND ($2::boolean OR public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id)=FALSE)
 ORDER BY public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) ASC,
          CASE WHEN COALESCE(p.is_free_tier,FALSE) THEN 1 ELSE 0 END ASC,
          CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id
               THEN 'infinity'::timestamptz
               ELSE s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval)
          END DESC,
          s.created_at DESC
 LIMIT 1
 `,[customerId,Boolean(includeBlocked)]);return result.rows[0]||null}
async function effectiveStremioSubscription(customerId,{client=null,includeBlocked=false}={}){
 const db=client||{query};const result=await db.query(`
 SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
        COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
        COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
        COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
        COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
        COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
        COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days,
        e.access_expires_at,e.blocked
 FROM effective_stremio_entitlements e
 JOIN subscriptions s ON s.id=e.subscription_id
 JOIN plans p ON p.id=e.plan_id
 WHERE e.customer_id=$1 AND ($2::boolean OR e.blocked=FALSE)
 LIMIT 1
 `,[customerId,Boolean(includeBlocked)]);return result.rows[0]||null}
async function effectiveEmbySubscription(customerId,{client=null,includeBlocked=false}={}){
 const db=client||{query};const result=await db.query(`
 SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
        COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
        COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
        COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
        COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
        COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
        COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days,
        e.access_expires_at,e.blocked
 FROM effective_emby_entitlements e
 JOIN subscriptions s ON s.id=e.subscription_id
 JOIN plans p ON p.id=e.plan_id
 WHERE e.customer_id=$1 AND ($2::boolean OR e.blocked=FALSE)
 LIMIT 1
 `,[customerId,Boolean(includeBlocked)]);return result.rows[0]||null}
async function liveFreeJellyfinSubscription(customerId,{client=null,includeBlocked=false}={}){
 const db=client||{query};const result=await db.query(`
 SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
        COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
        COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
        COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
        COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
        COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
        COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days,
        CASE WHEN o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id THEN 'infinity'::timestamptz ELSE s.current_period_end+((COALESCE(s.service_extension_days,0)||' days')::interval) END AS access_expires_at,
        public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
 FROM subscriptions s
 JOIN plans p ON p.id=s.plan_id
 LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
 WHERE s.customer_id=$1
   AND p.is_free_tier=TRUE
   AND COALESCE(p.is_addon,FALSE)=FALSE
   AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
   AND s.superseded_by IS NULL
   AND s.starts_at<=NOW()
   AND (
      (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
      OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end>NOW())
      OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN ('active','trialing','past_due','paused','cancelled','expired') AND (s.current_period_end+((s.service_extension_days||' days')::interval))>NOW())
   )
 ORDER BY s.created_at DESC
 LIMIT 1
 `,[customerId]);
 const row=result.rows[0]||null;if(!row)return null;
 const laneHold=await db.query(`SELECT EXISTS(
   SELECT 1 FROM customer_access_holds h
   WHERE h.customer_id=$1 AND h.released_at IS NULL AND (
     (h.hold_type='inactivity_policy' AND h.source_key=('plan:'||$2::text))
     OR (h.hold_type='jellyfin_cleanup' AND EXISTS(
       SELECT 1 FROM jellyfin_accounts ja
       WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin' AND ja.access_lane='free'
         AND h.source_key=('server:'||ja.server_id::text)
     ))
   )
 ) AS blocked`,[customerId,row.plan_id]);
 row.blocked=Boolean(row.blocked||laneHold.rows[0]?.blocked);
 if(!includeBlocked&&row.blocked)return null;
 return row;
}
async function effectiveAddons(customerId,{client=null,includeBlocked=false}={}){const db=client||{query};const result=await db.query(`
 SELECT s.*,p.*,s.id AS subscription_id,p.id AS plan_id,
        COALESCE(s.plan_name_snapshot,p.name) AS contract_plan_name,
        COALESCE(s.plan_code_snapshot,p.code) AS contract_plan_code,
        COALESCE(s.price_minor_snapshot,p.price_minor) AS contract_price_minor,
        COALESCE(s.currency_snapshot,p.currency) AS contract_currency,
        COALESCE(s.billing_interval_snapshot,p.billing_interval) AS contract_billing_interval,
        COALESCE(s.duration_days_snapshot,p.duration_days) AS contract_duration_days,
        a.access_expires_at,public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id) AS blocked
 FROM effective_customer_addons a
 JOIN subscriptions s ON s.id=a.subscription_id
 JOIN plans p ON p.id=a.plan_id
 WHERE a.customer_id=$1 AND ($2::boolean OR public.subscription_access_blocked(s.customer_id,s.source,s.provider_subscription_id)=FALSE)
 ORDER BY a.access_expires_at DESC,s.created_at DESC
 `,[customerId,Boolean(includeBlocked)]);return result.rows}
async function assertNoOtherLiveRecurring(client,customerId,excludeId=null,targetPlanId=null){
 const base=`s.customer_id=$1 AND s.superseded_by IS NULL AND s.id<>COALESCE($2::uuid,'00000000-0000-0000-0000-000000000000'::uuid) AND s.source IN('stripe','paypal') AND s.billing_mode='subscription' AND s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW()`;
 if(!targetPlanId){const result=await client.query(`SELECT s.id FROM subscriptions s WHERE ${base} LIMIT 1 FOR UPDATE`,[customerId,excludeId]);if(result.rowCount)throw new Error('A recurring subscription is already active for this customer. Change or cancel it instead of creating another one.');return;}
 const target=await client.query('SELECT id,is_addon,service_type FROM plans WHERE id=$1',[targetPlanId]);if(!target.rowCount)throw new Error('Plan not found.');
 if(target.rows[0].is_addon){const result=await client.query(`SELECT s.id FROM subscriptions s WHERE ${base} AND s.plan_id=$3 LIMIT 1 FOR UPDATE`,[customerId,excludeId,targetPlanId]);if(result.rowCount)throw new Error('This customer already has an active recurring subscription for this add-on.');return;}
 const result=await client.query(`SELECT s.id,s.service_type_snapshot,p.service_type,p.name FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE ${base} AND COALESCE(p.is_addon,FALSE)=FALSE FOR UPDATE OF s`,[customerId,excludeId]);
 const conflict=result.rows.find(row=>serviceScope.overlaps(row,target.rows[0]));
 if(conflict)throw new Error(`A recurring ${serviceScope.label(conflict)} subscription is already active for this customer. Change or cancel that service instead of creating another overlapping subscription.`);
}
function assertSafeSourceRewrite(existing,targetSource){if(recurringProvider(existing)&&!['stripe','paypal'].includes(String(targetSource||'')))throw new Error('A provider-managed recurring subscription cannot be converted into a manual subscription. Cancel/change provider billing through the billing workflow first.')}
async function markSuperseded(client,{subscriptionId,replacementId,reason='plan_change'}){await client.query(`UPDATE subscriptions SET superseded_by=$2,replaced_at=NOW(),replacement_reason=$3,updated_at=NOW() WHERE id=$1 AND superseded_by IS NULL`,[subscriptionId,replacementId,String(reason||'').slice(0,200)])}
module.exports={LIVE_STATUSES,recurringProvider,audienceAllows,assertAudience,effectiveSubscription,effectiveStremioSubscription,effectiveEmbySubscription,liveFreeJellyfinSubscription,effectiveAddons,assertNoOtherLiveRecurring,assertSafeSourceRewrite,markSuperseded};