'use strict';

const {query}=require('../db');
const placement=require('../jellyfin/placement');

const LIVE_STATUSES=['active','trialing','past_due','paused'];
const FLEET_OCCUPANT_STATUSES=['active','trialing'];
const FLEET_ACCESS_HOLD_TYPES=['inactivity_policy','jellyfin_cleanup'];
const RESERVATION_SQL=`consumed_at IS NULL AND released_at IS NULL AND expires_at>NOW()`;
const FLEET_CLASSES=new Set(['premium','free']);

function positiveInt(value,fallback=1){const n=Number(value);return Number.isInteger(n)&&n>0?n:fallback;}
function serviceType(plan){return String(plan?.service_type||'').toLowerCase();}
function serverClass(plan){return String(plan?.server_class||'').toLowerCase();}
function isTrial(plan){return String(plan?.billing_interval||'').toLowerCase()==='trial';}
function isFleetJellyfin(plan){return serviceType(plan)==='jellyfin'&&FLEET_CLASSES.has(serverClass(plan));}
function isStremio(plan){return serviceType(plan)==='stremio';}
function metricStaleSeconds(){return Math.max(60,Math.ceil(placement.metricsStaleMs()/1000));}
function capacityModel(plan){
  if(!plan||!plan.service_type)return'legacy_plan';
  if(serviceType(plan)==='stremio'||serviceType(plan)==='bundle'||serverClass(plan)==='custom')return'manual_plan';
  if(isFleetJellyfin(plan))return'fleet_streams';
  return'manual_plan';
}
function scarcity(state){
  if(!state)return{label:'Available',kind:'available'};
  if(state.soldOut||state.remaining===0)return{label:'Currently full',kind:'sold'};
  if(state.remaining==null)return{label:'Available',kind:'available'};
  const n=Math.max(0,Number(state.remaining)||0),noun=state.pool==='premium'?'Premium place':state.pool==='free'?'Free place':isTrial(state.plan)?'trial place':serviceType(state.plan)==='stremio'?'Stremio place':'place';
  const plural=n===1?noun:`${noun}s`;
  if(n<=3)return{label:`🔥 Only ${n} ${plural} left`,kind:'urgent'};
  if(n<=10)return{label:`Only ${n} ${plural} left`,kind:'limited'};
  return{label:'Available',kind:'available'};
}
function checkoutReservationSql(alias='i'){
  return `(${alias}.state<>'completed' AND ((
    ${alias}.state='open' AND ${alias}.expires_at>NOW()
  ) OR (
    ${alias}.provider_checkout_id IS NOT NULL
    AND ${alias}.provider_terminal_at IS NULL
    AND COALESCE(${alias}.capacity_hold_until,${alias}.expires_at)>NOW()
  )))`;
}
async function loadPlan(planId,db=query){
  const result=await db(`SELECT id,capacity_limit,service_type,server_class,billing_interval,price_minor,is_free_tier,streams,stremio_household_network_limit FROM plans WHERE id=$1`,[planId]);
  if(!result.rowCount)throw new Error('Plan not found.');
  return result.rows[0];
}
async function legacyUsage(plan,db=query,{excludeReservationId=null,excludeCheckoutIntentId=null}={}){
  const checkoutHold=checkoutReservationSql('i');
  const result=await db(`SELECT
      (SELECT COUNT(DISTINCT s.customer_id)::int FROM subscriptions s WHERE s.plan_id=$1 AND s.superseded_by IS NULL AND s.status=ANY($2::text[]) AND s.starts_at<=NOW() AND s.current_period_end>NOW()) AS used,
      ((SELECT COUNT(*)::int FROM free_access_registration_reservations r WHERE r.plan_id=$1 AND ${RESERVATION_SQL} AND ($3::uuid IS NULL OR r.id<>$3::uuid)) +
       (SELECT COUNT(*)::int FROM billing_checkout_intents i WHERE i.plan_id=$1 AND ${checkoutHold} AND ($4::uuid IS NULL OR i.id<>$4::uuid))) AS reserved`,[plan.id,LIVE_STATUSES,excludeReservationId,excludeCheckoutIntentId]);
  const row=result.rows[0]||{},limit=plan.capacity_limit==null?null:Number(plan.capacity_limit),used=Number(row.used||0),reserved=Number(row.reserved||0),occupied=used+reserved;
  const state={planId:plan.id,plan,model:'manual_plan',pool:null,limit,used,reserved,remaining:limit==null?null:Math.max(0,limit-occupied),soldOut:limit!=null&&occupied>=limit,manualLimit:limit,manualUsed:used,manualReserved:reserved};
  return{...state,...scarcity(state)};
}
async function stremioHouseholdUsage(plan,db=query,{excludeReservationId=null,excludeCheckoutIntentId=null,households=null}={}){
  const checkoutHold=checkoutReservationSql('i');
  const result=await db(`SELECT
      (SELECT COALESCE(SUM(GREATEST(1,COALESCE(
        CASE WHEN jsonb_typeof(s.commercial_snapshot->'stremioHouseholdNetworkLimit')='number' THEN (s.commercial_snapshot->>'stremioHouseholdNetworkLimit')::int END,
        s.stremio_household_network_limit_snapshot,p.stremio_household_network_limit,1))),0)::int
       FROM subscriptions s JOIN plans p ON p.id=s.plan_id
       WHERE s.plan_id=$1 AND s.superseded_by IS NULL AND s.status=ANY($2::text[]) AND s.starts_at<=NOW() AND s.current_period_end>NOW()) AS household_used,
      ((SELECT COALESCE(SUM(GREATEST(1,COALESCE(p.stremio_household_network_limit,1))),0)::int
        FROM free_access_registration_reservations r JOIN plans p ON p.id=r.plan_id
        WHERE r.plan_id=$1 AND ${RESERVATION_SQL} AND ($3::uuid IS NULL OR r.id<>$3::uuid)) +
       (SELECT COALESCE(SUM(GREATEST(1,COALESCE(
          CASE WHEN jsonb_typeof(i.commercial_snapshot->'stremioHouseholdNetworkLimit')='number' THEN (i.commercial_snapshot->>'stremioHouseholdNetworkLimit')::int END,
          p.stremio_household_network_limit,1))),0)::int
        FROM billing_checkout_intents i JOIN plans p ON p.id=i.plan_id
        WHERE i.plan_id=$1 AND ${checkoutHold} AND ($4::uuid IS NULL OR i.id<>$4::uuid))) AS household_reserved`,[plan.id,LIVE_STATUSES,excludeReservationId,excludeCheckoutIntentId]);
  const row=result.rows[0]||{},householdLimit=plan.capacity_limit==null?null:Number(plan.capacity_limit),householdUsed=Number(row.household_used||0),householdReserved=Number(row.household_reserved||0),householdRemaining=householdLimit==null?null:Math.max(0,householdLimit-householdUsed-householdReserved),requiredHouseholds=positiveInt(households,positiveInt(plan.stremio_household_network_limit,1));
  const limit=householdLimit==null?null:Math.floor(householdLimit/requiredHouseholds),remaining=householdRemaining==null?null:Math.floor(householdRemaining/requiredHouseholds),used=limit==null?householdUsed:Math.max(0,limit-remaining),state={planId:plan.id,plan,model:'manual_households',pool:'stremio',requiredHouseholds,householdLimit,householdUsed,householdReserved,householdRemaining,limit,used,reserved:0,remaining,soldOut:remaining!=null&&remaining<=0,manualLimit:householdLimit,manualUsed:householdUsed,manualReserved:householdReserved};
  return{...state,...scarcity(state)};
}
async function placementHealthMode(db=query){
  const result=await db(`SELECT setting_value FROM platform_settings WHERE setting_key='operations_v1'`);
  const mode=String(result.rows[0]?.setting_value?.placementHealthMode||'healthy_or_degraded');
  return['healthy_only','healthy_or_degraded','fail_open'].includes(mode)?mode:'healthy_or_degraded';
}
function healthSql(alias,mode){
  if(mode==='healthy_only')return`${alias}.health_status='healthy'`;
  if(mode==='fail_open')return`COALESCE(${alias}.health_status,'unknown')<>'offline'`;
  return`${alias}.health_status IN('healthy','degraded')`;
}
async function fleetStreams(plan,db=query,{excludeReservationId=null,excludeCheckoutIntentId=null}={}){
  const cls=serverClass(plan),healthMode=await placementHealthMode(db),health=healthSql('js',healthMode),staleSeconds=metricStaleSeconds();
  const serviceFlag=cls==='free'?'TRUE':isTrial(plan)?'js.trial_enabled=TRUE':'js.paid_enabled=TRUE';
  const configured=await db(`WITH restriction AS (
      SELECT EXISTS(
        SELECT 1 FROM plan_server_eligibility pse
        JOIN jellyfin_servers restricted_server ON restricted_server.id=pse.server_id
        WHERE pse.plan_id=$1 AND restricted_server.server_class=$2
          AND COALESCE(restricted_server.media_server_type,'jellyfin')='jellyfin'
      ) AS restricted
    ), eligible_servers AS (
      SELECT js.id,js.max_users
      FROM jellyfin_servers js
      CROSS JOIN restriction r
      LEFT JOIN plan_server_eligibility pse ON pse.plan_id=$1 AND pse.server_id=js.id
      WHERE js.server_class=$2
        AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
        AND js.max_users IS NOT NULL
        AND (NOT r.restricted OR pse.server_id IS NOT NULL)
        AND js.enabled=TRUE AND js.allow_new_users=TRUE
        AND COALESCE(js.placement_mode,'active')='active'
        AND ${health}
        AND ${serviceFlag}
    ), server_occupancy AS (
      SELECT es.id,es.max_users,
             COUNT(DISTINCT ja.id)::int AS enabled_accounts,
             CASE WHEN m.observed_at IS NOT NULL
                       AND m.observed_at>NOW()-($3::int*INTERVAL '1 second')
                  THEN GREATEST(0,COALESCE(m.total_users,0)) ELSE 0 END::int AS observed_users
      FROM eligible_servers es
      LEFT JOIN jellyfin_accounts ja ON ja.server_id=es.id AND ja.disabled=FALSE
      LEFT JOIN jellyfin_server_metrics m ON m.server_id=es.id
      GROUP BY es.id,es.max_users,m.total_users,m.observed_at
    )
    SELECT
      (SELECT COUNT(*)::int
       FROM jellyfin_servers js
       CROSS JOIN restriction r
       LEFT JOIN plan_server_eligibility pse ON pse.plan_id=$1 AND pse.server_id=js.id
       WHERE js.server_class=$2
         AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
         AND js.max_users IS NOT NULL
         AND (NOT r.restricted OR pse.server_id IS NOT NULL)) AS configured_servers,
      COALESCE(SUM(so.max_users),0)::int AS stream_limit,
      COALESCE(SUM(so.enabled_accounts),0)::int AS enabled_accounts,
      COALESCE(SUM(so.observed_users),0)::int AS observed_users,
      COALESCE(SUM(GREATEST(so.enabled_accounts,so.observed_users)),0)::int AS placement_users
    FROM server_occupancy so`,[plan.id,cls,staleSeconds]);
  const configuredServers=Number(configured.rows[0]?.configured_servers||0),streamLimit=Number(configured.rows[0]?.stream_limit||0),enabledAccountFloor=Number(configured.rows[0]?.enabled_accounts||0),observedUserFloor=Number(configured.rows[0]?.observed_users||0),placementUserFloor=Number(configured.rows[0]?.placement_users||0);
  if(!configuredServers)return null;
  const used=await db(`SELECT COALESCE(SUM(GREATEST(1,COALESCE(CASE WHEN jsonb_typeof(s.commercial_snapshot->'streams')='number' THEN (s.commercial_snapshot->>'streams')::int END,p.streams,1))),0)::int AS stream_used
    FROM subscriptions s JOIN plans p ON p.id=s.plan_id
    WHERE s.superseded_by IS NULL AND s.status=ANY($2::text[]) AND s.starts_at<=NOW() AND s.current_period_end>NOW()
      AND p.service_type IN('jellyfin','bundle') AND p.server_class=$1
      AND NOT EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=s.customer_id AND h.hold_type=ANY($3::text[]) AND h.released_at IS NULL)`,[cls,FLEET_OCCUPANT_STATUSES,FLEET_ACCESS_HOLD_TYPES]);
  const checkoutHold=checkoutReservationSql('i');
  const checkout=await db(`SELECT COALESCE(SUM(GREATEST(1,COALESCE(CASE WHEN jsonb_typeof(i.commercial_snapshot->'streams')='number' THEN (i.commercial_snapshot->>'streams')::int END,p.streams,1))),0)::int AS stream_reserved
    FROM billing_checkout_intents i JOIN plans p ON p.id=i.plan_id
    WHERE ${checkoutHold} AND p.service_type IN('jellyfin','bundle') AND p.server_class=$1
      AND ($2::uuid IS NULL OR i.id<>$2::uuid)`,[cls,excludeCheckoutIntentId]);
  const freeHolds=await db(`SELECT COALESCE(SUM(GREATEST(1,COALESCE(p.streams,1))),0)::int AS stream_reserved
    FROM free_access_registration_reservations r JOIN plans p ON p.id=r.plan_id
    WHERE ${RESERVATION_SQL} AND p.service_type IN('jellyfin','bundle') AND p.server_class=$1 AND ($2::uuid IS NULL OR r.id<>$2::uuid)`,[cls,excludeReservationId]);
  const entitlementStreamUsed=Number(used.rows[0]?.stream_used||0),streamUsed=Math.max(entitlementStreamUsed,placementUserFloor),streamReserved=Number(checkout.rows[0]?.stream_reserved||0)+Number(freeHolds.rows[0]?.stream_reserved||0),streamRemaining=Math.max(0,streamLimit-streamUsed-streamReserved),capacityGap=Math.max(0,placementUserFloor-entitlementStreamUsed);
  return{pool:cls,configuredServers,streamLimit,streamUsed,entitlementStreamUsed,enabledAccountFloor,observedUserFloor,placementUserFloor,capacityGap,streamReserved,streamRemaining,healthMode};
}
async function usage(planId,db=query,{excludeReservationId=null,excludeCheckoutIntentId=null,streams=null,households=null}={}){
  const plan=await loadPlan(planId,db),model=capacityModel(plan);
  if(isStremio(plan))return stremioHouseholdUsage(plan,db,{excludeReservationId,excludeCheckoutIntentId,households});
  if(model!=='fleet_streams')return legacyUsage(plan,db,{excludeReservationId,excludeCheckoutIntentId});
  const fleet=await fleetStreams(plan,db,{excludeReservationId,excludeCheckoutIntentId});
  const requiredStreams=positiveInt(streams,positiveInt(plan.streams,1));
  if(!fleet){
    const state={planId:plan.id,plan,model:'fleet_streams',pool:serverClass(plan),configuredServers:0,requiredStreams,streamLimit:0,streamUsed:0,entitlementStreamUsed:0,enabledAccountFloor:0,observedUserFloor:0,placementUserFloor:0,capacityGap:0,streamReserved:0,streamRemaining:0,healthMode:null,limit:0,used:0,reserved:0,remaining:0,soldOut:true,manualLimit:null,manualUsed:0,manualReserved:0,fallbackReason:'No Jellyfin server capacity is configured for this fleet plan.'};
    return{...state,...scarcity(state)};
  }
  const fleetLimit=Math.floor(fleet.streamLimit/requiredStreams),fleetRemaining=Math.floor(fleet.streamRemaining/requiredStreams),fleetUsed=Math.max(0,fleetLimit-fleetRemaining);
  let remaining=fleetRemaining,limit=fleetLimit,manualLimit=null,manualUsed=0,manualReserved=0;
  if(isTrial(plan)){
    const manual=await legacyUsage(plan,db,{excludeReservationId,excludeCheckoutIntentId});
    manualLimit=manual.limit;manualUsed=manual.used;manualReserved=manual.reserved;
    if(manual.remaining!=null)remaining=Math.min(remaining,manual.remaining);
    if(manual.limit!=null)limit=Math.min(limit,manual.limit);
  }
  const state={planId:plan.id,plan,model:'fleet_streams',pool:fleet.pool,configuredServers:fleet.configuredServers,requiredStreams,streamLimit:fleet.streamLimit,streamUsed:fleet.streamUsed,entitlementStreamUsed:fleet.entitlementStreamUsed,enabledAccountFloor:fleet.enabledAccountFloor,observedUserFloor:fleet.observedUserFloor,placementUserFloor:fleet.placementUserFloor,capacityGap:fleet.capacityGap,streamReserved:fleet.streamReserved,streamRemaining:fleet.streamRemaining,healthMode:fleet.healthMode,limit,used:fleetUsed,reserved:0,remaining,soldOut:remaining===0,manualLimit,manualUsed,manualReserved};
  return{...state,...scarcity(state)};
}

async function assertAvailable(planId,{db=query,label='This plan',excludeReservationId=null,excludeCheckoutIntentId=null,streams=null,households=null}={}){
  const state=await usage(planId,db,{excludeReservationId,excludeCheckoutIntentId,streams,households});
  if(state.soldOut){const error=new Error(`${label} is currently sold out.`);error.code='PLAN_CAPACITY_EXHAUSTED';error.planId=String(planId);throw error;}
  return state;
}

async function lockAndAssert(client,planId,label='This plan',{excludeReservationId=null,excludeCheckoutIntentId=null,streams=null,households=null}={}){
  const plan=await loadPlan(planId,(sql,params)=>client.query(sql,params)),model=capacityModel(plan),key=model==='fleet_streams'?`fleet:${serverClass(plan)}`:`plan:${planId}`;
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:capacity:'||$1::text, 77133))`,[key]);
  return assertAvailable(planId,{db:(sql,params)=>client.query(sql,params),label,excludeReservationId,excludeCheckoutIntentId,streams,households});
}

function legacyAcquisitionSql(alias='p'){
  const checkoutHold=checkoutReservationSql('ci');
  return `(${alias}.capacity_limit IS NULL OR ${alias}.capacity_limit > ((
    SELECT COUNT(DISTINCT cs.customer_id) FROM subscriptions cs
    WHERE cs.plan_id=${alias}.id AND cs.superseded_by IS NULL
      AND cs.status IN ('active','trialing','past_due','paused')
      AND cs.starts_at<=NOW() AND cs.current_period_end>NOW()
  ) + (
    SELECT COUNT(*) FROM free_access_registration_reservations cr
    WHERE cr.plan_id=${alias}.id AND cr.consumed_at IS NULL AND cr.released_at IS NULL AND cr.expires_at>NOW()
  ) + (
    SELECT COUNT(*) FROM billing_checkout_intents ci
    WHERE ci.plan_id=${alias}.id AND ${checkoutHold}
  )))`;
}
function fleetRestrictionSql(planAlias,serverAlias){
  return `(NOT EXISTS(
    SELECT 1 FROM plan_server_eligibility capacity_restriction
    JOIN jellyfin_servers restricted_server ON restricted_server.id=capacity_restriction.server_id
    WHERE capacity_restriction.plan_id=${planAlias}.id
      AND restricted_server.server_class=${planAlias}.server_class
      AND COALESCE(restricted_server.media_server_type,'jellyfin')='jellyfin'
  ) OR EXISTS(
    SELECT 1 FROM plan_server_eligibility capacity_match
    WHERE capacity_match.plan_id=${planAlias}.id
      AND capacity_match.server_id=${serverAlias}.id
  ))`;
}
function fleetConfiguredSql(alias='p'){
  const restriction=fleetRestrictionSql(alias,'configured_server');
  return `(${alias}.service_type='jellyfin' AND ${alias}.server_class IN('premium','free') AND EXISTS(
    SELECT 1 FROM jellyfin_servers configured_server
    WHERE configured_server.server_class=${alias}.server_class
      AND COALESCE(configured_server.media_server_type,'jellyfin')='jellyfin'
      AND configured_server.max_users IS NOT NULL
      AND ${restriction}
  ))`;
}
function fleetAvailableSql(alias='p'){
  const restriction=fleetRestrictionSql(alias,'capacity_server'),occupancyRestriction=fleetRestrictionSql(alias,'occupancy_server'),staleSeconds=metricStaleSeconds();
  const healthMode=`COALESCE((SELECT setting_value->>'placementHealthMode' FROM platform_settings WHERE setting_key='operations_v1'),'healthy_or_degraded')`;
  const healthFor=serverAlias=>`CASE ${healthMode}
    WHEN 'healthy_only' THEN ${serverAlias}.health_status='healthy'
    WHEN 'fail_open' THEN COALESCE(${serverAlias}.health_status,'unknown')<>'offline'
    ELSE ${serverAlias}.health_status IN('healthy','degraded')
  END`;
  const streamCapacity=`(
    SELECT COALESCE(SUM(capacity_server.max_users),0)
    FROM jellyfin_servers capacity_server
    WHERE capacity_server.server_class=${alias}.server_class
      AND COALESCE(capacity_server.media_server_type,'jellyfin')='jellyfin'
      AND capacity_server.max_users IS NOT NULL
      AND ${restriction}
      AND capacity_server.enabled=TRUE
      AND capacity_server.allow_new_users=TRUE
      AND COALESCE(capacity_server.placement_mode,'active')='active'
      AND ${healthFor('capacity_server')}
      AND (${alias}.server_class='free'
        OR (${alias}.billing_interval='trial' AND capacity_server.trial_enabled=TRUE)
        OR (${alias}.billing_interval<>'trial' AND capacity_server.paid_enabled=TRUE))
  )`;
  const activeStreams=`(
    SELECT COALESCE(SUM(GREATEST(1,COALESCE(
      CASE WHEN jsonb_typeof(active_subscription.commercial_snapshot->'streams')='number' THEN (active_subscription.commercial_snapshot->>'streams')::int END,
      active_plan.streams,1))),0)
    FROM subscriptions active_subscription
    JOIN plans active_plan ON active_plan.id=active_subscription.plan_id
    WHERE active_subscription.superseded_by IS NULL
      AND active_subscription.status IN ('active','trialing')
      AND active_subscription.starts_at<=NOW() AND active_subscription.current_period_end>NOW()
      AND active_plan.service_type IN('jellyfin','bundle')
      AND active_plan.server_class=${alias}.server_class
      AND NOT EXISTS(SELECT 1 FROM customer_access_holds capacity_access_hold
        WHERE capacity_access_hold.customer_id=active_subscription.customer_id
          AND capacity_access_hold.hold_type IN ('inactivity_policy','jellyfin_cleanup')
          AND capacity_access_hold.released_at IS NULL)
  )`;
  const placementUsers=`(
    SELECT COALESCE(SUM(server_load.capacity_users),0)
    FROM (
      SELECT occupancy_server.id,
             GREATEST(
               COUNT(DISTINCT capacity_account.id),
               CASE WHEN occupancy_metric.observed_at IS NOT NULL
                         AND occupancy_metric.observed_at>NOW()-INTERVAL '${staleSeconds} seconds'
                    THEN GREATEST(0,COALESCE(occupancy_metric.total_users,0)) ELSE 0 END
             ) AS capacity_users
      FROM jellyfin_servers occupancy_server
      LEFT JOIN jellyfin_accounts capacity_account ON capacity_account.server_id=occupancy_server.id AND capacity_account.disabled=FALSE
      LEFT JOIN jellyfin_server_metrics occupancy_metric ON occupancy_metric.server_id=occupancy_server.id
      WHERE occupancy_server.server_class=${alias}.server_class
        AND COALESCE(occupancy_server.media_server_type,'jellyfin')='jellyfin'
        AND occupancy_server.max_users IS NOT NULL
        AND ${occupancyRestriction}
        AND occupancy_server.enabled=TRUE
        AND occupancy_server.allow_new_users=TRUE
        AND COALESCE(occupancy_server.placement_mode,'active')='active'
        AND ${healthFor('occupancy_server')}
        AND (${alias}.server_class='free'
          OR (${alias}.billing_interval='trial' AND occupancy_server.trial_enabled=TRUE)
          OR (${alias}.billing_interval<>'trial' AND occupancy_server.paid_enabled=TRUE))
      GROUP BY occupancy_server.id,occupancy_metric.total_users,occupancy_metric.observed_at
    ) server_load
  )`;
  const checkoutHold=checkoutReservationSql('capacity_checkout');
  const checkoutHolds=`(
    SELECT COALESCE(SUM(GREATEST(1,COALESCE(
      CASE WHEN jsonb_typeof(capacity_checkout.commercial_snapshot->'streams')='number' THEN (capacity_checkout.commercial_snapshot->>'streams')::int END,
      checkout_plan.streams,1))),0)
    FROM billing_checkout_intents capacity_checkout
    JOIN plans checkout_plan ON checkout_plan.id=capacity_checkout.plan_id
    WHERE ${checkoutHold}
      AND checkout_plan.service_type IN('jellyfin','bundle')
      AND checkout_plan.server_class=${alias}.server_class
  )`;
  const freeHolds=`(
    SELECT COALESCE(SUM(GREATEST(1,COALESCE(free_plan.streams,1))),0)
    FROM free_access_registration_reservations capacity_free_hold
    JOIN plans free_plan ON free_plan.id=capacity_free_hold.plan_id
    WHERE capacity_free_hold.consumed_at IS NULL
      AND capacity_free_hold.released_at IS NULL
      AND capacity_free_hold.expires_at>NOW()
      AND free_plan.service_type IN('jellyfin','bundle')
      AND free_plan.server_class=${alias}.server_class
  )`;
  return `(${streamCapacity} >= (GREATEST(${activeStreams},${placementUsers}) + ${checkoutHolds} + ${freeHolds} + GREATEST(1,COALESCE(${alias}.streams,1))))`;
}
function acquisitionSql(alias='p'){
  const fleetPlan=`(${alias}.service_type='jellyfin' AND ${alias}.server_class IN('premium','free'))`,fleetConfigured=fleetConfiguredSql(alias),fleetAvailable=fleetAvailableSql(alias),manualAvailable=legacyAcquisitionSql(alias);
  return `((NOT ${fleetPlan} AND ${manualAvailable}) OR (${fleetPlan} AND ${fleetConfigured} AND ${fleetAvailable} AND (${alias}.billing_interval<>'trial' OR ${manualAvailable})))`;
}

module.exports={LIVE_STATUSES,usage,assertAvailable,lockAndAssert,acquisitionSql,legacyAcquisitionSql,capacityModel,scarcity,isFleetJellyfin,stremioHouseholdUsage,checkoutReservationSql};
