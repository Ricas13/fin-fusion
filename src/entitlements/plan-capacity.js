'use strict';

const {query}=require('../db');

const LIVE_STATUSES=['active','trialing','past_due','paused'];
const FLEET_ACCESS_HOLD_TYPES=['inactivity_policy','jellyfin_cleanup'];
const RESERVATION_SQL=`consumed_at IS NULL AND released_at IS NULL AND expires_at>NOW()`;

function positiveInt(value,fallback=1){const n=Number(value);return Number.isInteger(n)&&n>0?n:fallback;}
function serviceType(plan){return String(plan?.service_type||'').toLowerCase();}
function serverClass(plan){return String(plan?.server_class||'').toLowerCase();}
function isTrial(plan){return String(plan?.billing_interval||'').toLowerCase()==='trial';}
function isFleetJellyfin(plan){return['jellyfin','bundle'].includes(serviceType(plan));}
function isStremio(plan){return serviceType(plan)==='stremio';}
function runtimeAdmissionSql(plan,alias='js'){
  if(isTrial(plan))return`${alias}.trial_enabled=TRUE`;
  if(Number(plan?.price_minor||0)>0)return`${alias}.paid_enabled=TRUE`;
  return'TRUE';
}
function capacityModel(plan){
  if(!plan||!plan.service_type)return'legacy_plan';
  if(isFleetJellyfin(plan))return'fleet_users';
  if(serviceType(plan)==='stremio')return'manual_households';
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
function freePendingUnblockedSql(subscriptionAlias,holdAlias='free_pending_hold'){
  return `(
    public.subscription_admin_present(${subscriptionAlias}.customer_id,'jellyfin',${subscriptionAlias}.id)
    OR NOT EXISTS(
      SELECT 1
      FROM customer_access_holds ${holdAlias}
      WHERE ${holdAlias}.customer_id=${subscriptionAlias}.customer_id
        AND ${holdAlias}.released_at IS NULL
        AND (
          (
            ${holdAlias}.hold_type='inactivity_policy'
            AND ${holdAlias}.source_key=('plan:'||${subscriptionAlias}.plan_id::text)
            AND (
              ${holdAlias}.metadata->>'subscriptionId'=${subscriptionAlias}.id::text
              OR (
                ${holdAlias}.metadata->>'subscriptionId' IS NULL
                AND ${holdAlias}.created_at>=${subscriptionAlias}.created_at
              )
            )
          )
          OR (
            ${holdAlias}.hold_type='jellyfin_cleanup'
            AND EXISTS(
              SELECT 1
              FROM jellyfin_accounts free_hold_account
              WHERE free_hold_account.customer_id=${subscriptionAlias}.customer_id
                AND free_hold_account.account_purpose='jellyfin'
                AND free_hold_account.access_lane='free'
                AND ${holdAlias}.source_key=('server:'||free_hold_account.server_id::text)
            )
          )
          OR ${holdAlias}.hold_type NOT IN('payment_delinquency','inactivity_policy','jellyfin_cleanup')
        )
    )
  )`;
}
function managedMediaLimit(plan){
  const policy=plan?.inactivity_policy&&typeof plan.inactivity_policy==='object'?plan.inactivity_policy:{};
  if(policy.mediaCapacityManaged!==true)return null;
  return plan.capacity_limit==null?null:Math.max(0,Number(plan.capacity_limit)||0);
}
function pendingPlanChangeUsersSql(planExpr){
  return `(
    SELECT COUNT(*)::int
    FROM customer_plan_changes capacity_change
    JOIN subscriptions capacity_current ON capacity_current.id=capacity_change.current_subscription_id
    WHERE capacity_change.target_plan_id=${planExpr}
      AND capacity_change.provider='stripe'
      AND capacity_change.state='pending'
      AND capacity_current.superseded_by IS NULL
      AND capacity_current.plan_id<>${planExpr}
  )`;
}
function immediatePlanChangeUsersSql(planExpr){
  return `(
    SELECT COUNT(*)::int
    FROM provider_operations capacity_operation
    JOIN subscriptions capacity_current
      ON capacity_current.id::text=capacity_operation.request_snapshot->>'subscriptionId'
    WHERE capacity_operation.provider='stripe'
      AND capacity_operation.scope='customer'
      AND capacity_operation.operation_type='plan_change_immediate'
      AND capacity_operation.state IN('planned','provider_applied','local_applied')
      AND COALESCE(capacity_operation.failure_kind,'') NOT IN('terminal','superseded')
      AND COALESCE(capacity_operation.provider_result->>'capacityReserved','false')='true'
      AND capacity_operation.request_snapshot->>'targetPlanId'=(${planExpr})::text
      AND capacity_current.superseded_by IS NULL
      AND capacity_current.plan_id<>${planExpr}
  )`;
}
async function loadPlan(planId,db=query){
  const result=await db(`SELECT id,capacity_limit,inactivity_policy,service_type,server_class,billing_interval,price_minor,is_free_tier,stremio_household_network_limit FROM plans WHERE id=$1`,[planId]);
  if(!result.rowCount)throw new Error('Plan not found.');
  return result.rows[0];
}
async function legacyUsage(plan,db=query,{excludeReservationId=null,excludeCheckoutIntentId=null}={}){
  const checkoutHold=checkoutReservationSql('i');
  const result=await db(`SELECT
      (SELECT COUNT(DISTINCT s.customer_id)::int FROM subscriptions s WHERE s.plan_id=$1 AND s.superseded_by IS NULL AND s.status=ANY($2::text[]) AND s.starts_at<=NOW() AND s.current_period_end>NOW()) AS used,
      ((SELECT COUNT(*)::int FROM free_access_registration_reservations r WHERE r.plan_id=$1 AND ${RESERVATION_SQL} AND ($3::uuid IS NULL OR r.id<>$3::uuid)) +
       (SELECT COUNT(*)::int FROM billing_checkout_intents i WHERE i.plan_id=$1 AND ${checkoutHold} AND ($4::uuid IS NULL OR i.id<>$4::uuid)) +
       ${pendingPlanChangeUsersSql('$1')} +
       ${immediatePlanChangeUsersSql('$1')}) AS reserved`,[plan.id,LIVE_STATUSES,excludeReservationId,excludeCheckoutIntentId]);
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
async function fleetUsers(plan,db=query,{excludeReservationId=null,excludeCheckoutIntentId=null}={}){
  const cls=serverClass(plan),healthMode=await placementHealthMode(db),health=healthSql('js',healthMode),serviceFlag=runtimeAdmissionSql(plan,'js');
  const configured=await db(`WITH restriction AS (
      SELECT EXISTS(
        SELECT 1 FROM plan_server_eligibility pse
        JOIN jellyfin_servers restricted_server ON restricted_server.id=pse.server_id
        WHERE pse.plan_id=$1
          AND COALESCE(restricted_server.media_server_type,'jellyfin')='jellyfin'
      ) AS restricted
    ), eligible_servers AS (
      SELECT js.id,js.max_users
      FROM jellyfin_servers js
      CROSS JOIN restriction r
      LEFT JOIN plan_server_eligibility pse ON pse.plan_id=$1 AND pse.server_id=js.id
      WHERE COALESCE(js.media_server_type,'jellyfin')='jellyfin'
        AND js.max_users IS NOT NULL
        AND ((r.restricted AND pse.server_id IS NOT NULL) OR (NOT r.restricted AND js.server_class=$2))
        AND js.enabled=TRUE AND js.allow_new_users=TRUE
        AND COALESCE(js.placement_mode,'active')='active'
        AND ${health}
        AND ${serviceFlag}
    ), server_occupancy AS (
      SELECT es.id,es.max_users,COUNT(DISTINCT ja.customer_id)::int AS managed_users
      FROM eligible_servers es
      LEFT JOIN jellyfin_accounts ja ON ja.server_id=es.id AND ja.disabled=FALSE AND ja.account_purpose='jellyfin'
      GROUP BY es.id,es.max_users
    )
    SELECT
      (SELECT COUNT(*)::int
       FROM jellyfin_servers js
       CROSS JOIN restriction r
       LEFT JOIN plan_server_eligibility pse ON pse.plan_id=$1 AND pse.server_id=js.id
       WHERE COALESCE(js.media_server_type,'jellyfin')='jellyfin'
         AND js.max_users IS NOT NULL
         AND ((r.restricted AND pse.server_id IS NOT NULL) OR (NOT r.restricted AND js.server_class=$2))) AS configured_servers,
      COALESCE(SUM(so.max_users),0)::int AS user_limit,
      COALESCE(SUM(so.managed_users),0)::int AS managed_users
    FROM server_occupancy so`,[plan.id,cls]);
  const configuredServers=Number(configured.rows[0]?.configured_servers||0),physicalUserLimit=Number(configured.rows[0]?.user_limit||0),managedUsers=Number(configured.rows[0]?.managed_users||0);
  if(!configuredServers)return null;

  // An already-entitled customer who has not yet received an enabled account
  // owns one place. This prevents a failed setup from reopening that place to
  // somebody else before the owed customer is repaired.
  const pending=await db(`SELECT COUNT(DISTINCT s.customer_id)::int AS pending_users
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    LEFT JOIN customer_entitlement_overrides o ON o.customer_id=s.customer_id AND o.subscription_id=s.id
    WHERE s.superseded_by IS NULL AND s.starts_at<=NOW()
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN('jellyfin','bundle')
      AND EXISTS(
        SELECT 1
        FROM jellyfin_servers overlap_server
        WHERE COALESCE(overlap_server.media_server_type,'jellyfin')='jellyfin'
          AND (
            EXISTS(SELECT 1 FROM plan_server_eligibility current_map WHERE current_map.plan_id=$4 AND current_map.server_id=overlap_server.id)
            OR (
              NOT EXISTS(SELECT 1 FROM plan_server_eligibility current_any JOIN jellyfin_servers mapped_provider ON mapped_provider.id=current_any.server_id WHERE current_any.plan_id=$4 AND COALESCE(mapped_provider.media_server_type,'jellyfin')='jellyfin')
              AND overlap_server.server_class=$1
            )
          )
          AND (
            EXISTS(SELECT 1 FROM plan_server_eligibility pending_map WHERE pending_map.plan_id=p.id AND pending_map.server_id=overlap_server.id)
            OR (
              NOT EXISTS(SELECT 1 FROM plan_server_eligibility pending_any JOIN jellyfin_servers mapped_provider ON mapped_provider.id=pending_any.server_id WHERE pending_any.plan_id=p.id AND COALESCE(mapped_provider.media_server_type,'jellyfin')='jellyfin')
              AND overlap_server.server_class=p.server_class
            )
          )
      )
      AND (
        (o.permanent_access=TRUE AND o.revoked_at IS NULL)
        OR (s.status=ANY($2::text[]) AND s.current_period_end>NOW())
        OR (COALESCE(s.service_extension_days,0)>0 AND s.status IN('active','trialing','past_due','paused','cancelled','expired') AND (s.current_period_end+((s.service_extension_days||' days')::interval))>NOW())
      )
      AND NOT public.subscription_admin_removed(s.customer_id,'jellyfin')
      AND (
        (
          COALESCE(p.is_free_tier,FALSE)=TRUE
          AND ${freePendingUnblockedSql('s','free_pending_hold')}
        )
        OR (
          COALESCE(p.is_free_tier,FALSE)=FALSE
          AND NOT EXISTS(
            SELECT 1 FROM customer_access_holds h
            WHERE h.customer_id=s.customer_id
              AND h.hold_type=ANY($3::text[])
              AND h.released_at IS NULL
          )
        )
      )
      AND NOT EXISTS(
        SELECT 1 FROM jellyfin_accounts existing
        JOIN jellyfin_servers existing_server ON existing_server.id=existing.server_id
        WHERE existing.customer_id=s.customer_id
          AND existing.disabled=FALSE
          AND existing.account_purpose='jellyfin'
          AND COALESCE(existing_server.media_server_type,'jellyfin')='jellyfin'
          AND (
            EXISTS(SELECT 1 FROM plan_server_eligibility current_existing_map WHERE current_existing_map.plan_id=$4 AND current_existing_map.server_id=existing_server.id)
            OR (
              NOT EXISTS(SELECT 1 FROM plan_server_eligibility current_existing_any JOIN jellyfin_servers mapped_provider ON mapped_provider.id=current_existing_any.server_id WHERE current_existing_any.plan_id=$4 AND COALESCE(mapped_provider.media_server_type,'jellyfin')='jellyfin')
              AND existing_server.server_class=$1
            )
          )
      )`,[cls,LIVE_STATUSES,FLEET_ACCESS_HOLD_TYPES,plan.id]);
  const checkoutHold=checkoutReservationSql('i');
  const checkout=await db(`SELECT COUNT(*)::int AS reserved_users
    FROM billing_checkout_intents i JOIN plans p ON p.id=i.plan_id
    WHERE ${checkoutHold}
      AND p.service_type IN('jellyfin','bundle')
      AND EXISTS(
        SELECT 1 FROM jellyfin_servers overlap_server
        WHERE COALESCE(overlap_server.media_server_type,'jellyfin')='jellyfin'
          AND (
            EXISTS(SELECT 1 FROM plan_server_eligibility current_map WHERE current_map.plan_id=$3 AND current_map.server_id=overlap_server.id)
            OR (NOT EXISTS(SELECT 1 FROM plan_server_eligibility current_any JOIN jellyfin_servers mapped_provider ON mapped_provider.id=current_any.server_id WHERE current_any.plan_id=$3 AND COALESCE(mapped_provider.media_server_type,'jellyfin')='jellyfin') AND overlap_server.server_class=$1)
          )
          AND (
            EXISTS(SELECT 1 FROM plan_server_eligibility other_map WHERE other_map.plan_id=p.id AND other_map.server_id=overlap_server.id)
            OR (NOT EXISTS(SELECT 1 FROM plan_server_eligibility other_any JOIN jellyfin_servers mapped_provider ON mapped_provider.id=other_any.server_id WHERE other_any.plan_id=p.id AND COALESCE(mapped_provider.media_server_type,'jellyfin')='jellyfin') AND overlap_server.server_class=p.server_class)
          )
      )
      AND ($2::uuid IS NULL OR i.id<>$2::uuid)`,[cls,excludeCheckoutIntentId,plan.id]);
  const freeHolds=await db(`SELECT COUNT(*)::int AS reserved_users
    FROM free_access_registration_reservations r JOIN plans p ON p.id=r.plan_id
    WHERE ${RESERVATION_SQL} AND p.service_type IN('jellyfin','bundle')
      AND EXISTS(
        SELECT 1 FROM jellyfin_servers overlap_server
        WHERE COALESCE(overlap_server.media_server_type,'jellyfin')='jellyfin'
          AND (
            EXISTS(SELECT 1 FROM plan_server_eligibility current_map WHERE current_map.plan_id=$3 AND current_map.server_id=overlap_server.id)
            OR (NOT EXISTS(SELECT 1 FROM plan_server_eligibility current_any JOIN jellyfin_servers mapped_provider ON mapped_provider.id=current_any.server_id WHERE current_any.plan_id=$3 AND COALESCE(mapped_provider.media_server_type,'jellyfin')='jellyfin') AND overlap_server.server_class=$1)
          )
          AND (
            EXISTS(SELECT 1 FROM plan_server_eligibility other_map WHERE other_map.plan_id=p.id AND other_map.server_id=overlap_server.id)
            OR (NOT EXISTS(SELECT 1 FROM plan_server_eligibility other_any JOIN jellyfin_servers mapped_provider ON mapped_provider.id=other_any.server_id WHERE other_any.plan_id=p.id AND COALESCE(mapped_provider.media_server_type,'jellyfin')='jellyfin') AND overlap_server.server_class=p.server_class)
          )
      )
      AND ($2::uuid IS NULL OR r.id<>$2::uuid)`,[cls,excludeReservationId,plan.id]);
  const pendingUsers=Number(pending.rows[0]?.pending_users||0);
  const fleetReservedUsers=Number(checkout.rows[0]?.reserved_users||0)+Number(freeHolds.rows[0]?.reserved_users||0);
  const physicalUsed=managedUsers+pendingUsers;
  const physicalRemaining=Math.max(0,physicalUserLimit-physicalUsed-fleetReservedUsers);

  // Product capacity is independent from infrastructure capacity. A plan can
  // deliberately expose only part of the eligible fleet (for example 50 Free
  // places on a server that can physically host 200 managed customers).
  const planUsage=await db(`SELECT
      (
        SELECT COUNT(DISTINCT s.customer_id)::int
        FROM subscriptions s
        LEFT JOIN customer_entitlement_overrides o
          ON o.customer_id=s.customer_id AND o.subscription_id=s.id
        WHERE s.plan_id=$1
          AND s.superseded_by IS NULL
          AND s.starts_at<=NOW()
          AND (
            (o.permanent_access=TRUE AND o.revoked_at IS NULL)
            OR public.subscription_admin_present(s.customer_id,'jellyfin',s.id)
            OR (s.status=ANY($2::text[]) AND s.current_period_end>NOW())
            OR (
              COALESCE(s.service_extension_days,0)>0
              AND s.status IN('active','trialing','past_due','paused','cancelled','expired')
              AND s.current_period_end+((s.service_extension_days||' days')::interval)>NOW()
            )
          )
          AND NOT public.subscription_admin_removed(s.customer_id,'jellyfin')
          AND (
            COALESCE($5::boolean,FALSE)=FALSE
            OR ${freePendingUnblockedSql('s','plan_free_hold')}
          )
      ) AS used,
      (
        (SELECT COUNT(*)::int
         FROM free_access_registration_reservations r
         WHERE r.plan_id=$1 AND ${RESERVATION_SQL}
           AND ($3::uuid IS NULL OR r.id<>$3::uuid))
        +
        (SELECT COUNT(*)::int
         FROM billing_checkout_intents i
         WHERE i.plan_id=$1 AND ${checkoutHold}
           AND ($4::uuid IS NULL OR i.id<>$4::uuid))
        + ${pendingPlanChangeUsersSql('$1')}
        + ${immediatePlanChangeUsersSql('$1')}
      ) AS reserved`,[
        plan.id,LIVE_STATUSES,excludeReservationId,excludeCheckoutIntentId,Boolean(plan.is_free_tier)
      ]);
  const planUsed=Number(planUsage.rows[0]?.used||0);
  const planReserved=Number(planUsage.rows[0]?.reserved||0);
  const planLimit=managedMediaLimit(plan);
  const planRemaining=planLimit==null?null:Math.max(0,planLimit-planUsed-planReserved);
  const userRemaining=planRemaining==null?physicalRemaining:Math.min(physicalRemaining,planRemaining);
  const effectiveLimit=planLimit==null?physicalUserLimit:Math.min(physicalUserLimit,planLimit);

  return{
    pool:cls||'jellyfin',
    configuredServers,
    userLimit:effectiveLimit,
    physicalUserLimit,
    planUserLimit:planLimit,
    userUsed:planLimit==null?physicalUsed:planUsed,
    managedUsers,
    pendingUsers,
    reservedUsers:planLimit==null?fleetReservedUsers:planReserved,
    fleetReservedUsers,
    physicalUsed,
    physicalRemaining,
    planUsed,
    planReserved,
    planRemaining,
    userRemaining,
    healthMode
  };
}

async function usage(planId,db=query,{excludeReservationId=null,excludeCheckoutIntentId=null,households=null}={}){
  const plan=await loadPlan(planId,db),model=capacityModel(plan);
  if(isStremio(plan))return stremioHouseholdUsage(plan,db,{excludeReservationId,excludeCheckoutIntentId,households});
  if(model!=='fleet_users')return legacyUsage(plan,db,{excludeReservationId,excludeCheckoutIntentId});
  const fleet=await fleetUsers(plan,db,{excludeReservationId,excludeCheckoutIntentId});
  if(!fleet){
    const state={planId:plan.id,plan,model:'fleet_users',pool:serverClass(plan)||'jellyfin',configuredServers:0,userLimit:0,userUsed:0,managedUsers:0,pendingUsers:0,reservedUsers:0,userRemaining:0,healthMode:null,limit:0,used:0,reserved:0,remaining:0,soldOut:true,manualLimit:null,manualUsed:0,manualReserved:0,fallbackReason:'No Jellyfin server user capacity is configured for this plan.'};
    return{...state,...scarcity(state)};
  }
  const state={planId:plan.id,plan,model:'fleet_users',pool:fleet.pool,configuredServers:fleet.configuredServers,userLimit:fleet.userLimit,physicalUserLimit:fleet.physicalUserLimit,planUserLimit:fleet.planUserLimit,userUsed:fleet.userUsed,managedUsers:fleet.managedUsers,pendingUsers:fleet.pendingUsers,reservedUsers:fleet.reservedUsers,fleetReservedUsers:fleet.fleetReservedUsers,physicalUsed:fleet.physicalUsed,physicalRemaining:fleet.physicalRemaining,planUsed:fleet.planUsed,planReserved:fleet.planReserved,planRemaining:fleet.planRemaining,userRemaining:fleet.userRemaining,healthMode:fleet.healthMode,limit:fleet.userLimit,used:fleet.userUsed,reserved:fleet.reservedUsers,remaining:fleet.userRemaining,soldOut:fleet.userRemaining===0,manualLimit:null,manualUsed:0,manualReserved:0};
  return{...state,...scarcity(state)};
}

async function assertAvailable(planId,{db=query,label='This plan',excludeReservationId=null,excludeCheckoutIntentId=null,households=null}={}){
  const state=await usage(planId,db,{excludeReservationId,excludeCheckoutIntentId,households});
  if(state.soldOut){const error=new Error(`${label} is currently sold out.`);error.code='PLAN_CAPACITY_EXHAUSTED';error.planId=String(planId);throw error;}
  return state;
}

async function lockAndAssert(client,planId,label='This plan',{excludeReservationId=null,excludeCheckoutIntentId=null,households=null}={}){
  const plan=await loadPlan(planId,(sql,params)=>client.query(sql,params)),model=capacityModel(plan),key=model==='fleet_users'?'fleet-users':`plan:${planId}`;
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:capacity:'||$1::text, 77133))`,[key]);
  // During a rolling deployment the previous release still takes the class
  // lock. Retain it after the global pool lock so both generations serialize.
  if(model==='fleet_users')await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:capacity:'||$1::text, 77133))`,[`fleet-users:${serverClass(plan)||'unclassified'}`]);
  return assertAvailable(planId,{db:(sql,params)=>client.query(sql,params),label,excludeReservationId,excludeCheckoutIntentId,households});
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
function planPoolServerSql(planAlias,serverAlias){
  return `(
    EXISTS(
      SELECT 1 FROM plan_server_eligibility pool_map
      JOIN jellyfin_servers pool_mapped_server ON pool_mapped_server.id=pool_map.server_id
      WHERE pool_map.plan_id=${planAlias}.id
        AND pool_map.server_id=${serverAlias}.id
        AND COALESCE(pool_mapped_server.media_server_type,'jellyfin')='jellyfin'
    )
    OR (
      NOT EXISTS(
        SELECT 1 FROM plan_server_eligibility pool_any
        JOIN jellyfin_servers pool_any_server ON pool_any_server.id=pool_any.server_id
        WHERE pool_any.plan_id=${planAlias}.id
          AND COALESCE(pool_any_server.media_server_type,'jellyfin')='jellyfin'
      )
      AND ${serverAlias}.server_class=${planAlias}.server_class
    )
  )`;
}
function planPoolOverlapSql(leftPlanAlias,rightPlanAlias){
  return `EXISTS(
    SELECT 1 FROM jellyfin_servers overlap_server
    WHERE COALESCE(overlap_server.media_server_type,'jellyfin')='jellyfin'
      AND ${planPoolServerSql(leftPlanAlias,'overlap_server')}
      AND ${planPoolServerSql(rightPlanAlias,'overlap_server')}
  )`;
}

function mediaPlanLimitAvailableSql(alias='p'){
  const checkoutHold=checkoutReservationSql('media_ci');
  return `(COALESCE(${alias}.inactivity_policy->'mediaCapacityManaged','false'::jsonb)<>'true'::jsonb OR ${alias}.capacity_limit IS NULL OR ${alias}.capacity_limit > ((
    SELECT COUNT(DISTINCT media_s.customer_id)
    FROM subscriptions media_s
    LEFT JOIN customer_entitlement_overrides media_o ON media_o.customer_id=media_s.customer_id AND media_o.subscription_id=media_s.id
    WHERE media_s.plan_id=${alias}.id
      AND media_s.superseded_by IS NULL
      AND media_s.starts_at<=NOW()
      AND NOT public.subscription_admin_removed(media_s.customer_id,'jellyfin')
      AND (COALESCE(${alias}.is_free_tier,FALSE)=FALSE OR ${freePendingUnblockedSql('media_s','media_plan_hold')})
      AND (
        (media_o.permanent_access=TRUE AND media_o.revoked_at IS NULL AND media_o.subscription_id=media_s.id)
        OR public.subscription_admin_present(media_s.customer_id,'jellyfin',media_s.id)
        OR (media_s.status IN('active','trialing','past_due','paused') AND media_s.current_period_end>NOW())
        OR (
          COALESCE(media_s.service_extension_days,0)>0
          AND media_s.status IN('active','trialing','past_due','paused','cancelled','expired')
          AND (media_s.current_period_end+((media_s.service_extension_days||' days')::interval))>NOW()
        )
      )
  ) + (
    SELECT COUNT(*) FROM free_access_registration_reservations media_fr
    WHERE media_fr.plan_id=${alias}.id
      AND media_fr.consumed_at IS NULL AND media_fr.released_at IS NULL AND media_fr.expires_at>NOW()
  ) + (
    SELECT COUNT(*) FROM billing_checkout_intents media_ci
    WHERE media_ci.plan_id=${alias}.id AND ${checkoutHold}
  ) + ${pendingPlanChangeUsersSql(`${alias}.id`)} + ${immediatePlanChangeUsersSql(`${alias}.id`)}))`;
}

function fleetRestrictionSql(planAlias,serverAlias){
  return `(NOT EXISTS(
    SELECT 1 FROM plan_server_eligibility capacity_restriction
    JOIN jellyfin_servers restricted_server ON restricted_server.id=capacity_restriction.server_id
    WHERE capacity_restriction.plan_id=${planAlias}.id
      AND COALESCE(restricted_server.media_server_type,'jellyfin')='jellyfin'
  ) OR EXISTS(
    SELECT 1 FROM plan_server_eligibility capacity_match
    WHERE capacity_match.plan_id=${planAlias}.id
      AND capacity_match.server_id=${serverAlias}.id
  ))`;
}
function fleetConfiguredSql(alias='p'){
  const restriction=fleetRestrictionSql(alias,'configured_server');
  return `(${alias}.service_type IN('jellyfin','bundle') AND EXISTS(
    SELECT 1 FROM jellyfin_servers configured_server
    WHERE COALESCE(configured_server.media_server_type,'jellyfin')='jellyfin'
      AND configured_server.max_users IS NOT NULL
      AND ${planPoolServerSql(alias,'configured_server')}
  ))`;
}
function fleetAvailableSql(alias='p'){
  const restriction=fleetRestrictionSql(alias,'capacity_server'),occupancyRestriction=fleetRestrictionSql(alias,'occupancy_server');
  const healthMode=`COALESCE((SELECT setting_value->>'placementHealthMode' FROM platform_settings WHERE setting_key='operations_v1'),'healthy_or_degraded')`;
  const healthFor=serverAlias=>`CASE ${healthMode}
    WHEN 'healthy_only' THEN ${serverAlias}.health_status='healthy'
    WHEN 'fail_open' THEN COALESCE(${serverAlias}.health_status,'unknown')<>'offline'
    ELSE ${serverAlias}.health_status IN('healthy','degraded')
  END`;
  const admissionFor=serverAlias=>`(
    (${alias}.billing_interval='trial' AND ${serverAlias}.trial_enabled=TRUE)
    OR (${alias}.billing_interval<>'trial' AND COALESCE(${alias}.price_minor,0)>0 AND ${serverAlias}.paid_enabled=TRUE)
    OR (${alias}.billing_interval<>'trial' AND COALESCE(${alias}.price_minor,0)=0)
  )`;
  const userCapacity=`(
    SELECT COALESCE(SUM(capacity_server.max_users),0)
    FROM jellyfin_servers capacity_server
    WHERE COALESCE(capacity_server.media_server_type,'jellyfin')='jellyfin'
      AND capacity_server.max_users IS NOT NULL
      AND ${planPoolServerSql(alias,'capacity_server')}
      AND capacity_server.enabled=TRUE
      AND capacity_server.allow_new_users=TRUE
      AND COALESCE(capacity_server.placement_mode,'active')='active'
      AND ${healthFor('capacity_server')}
      AND ${admissionFor('capacity_server')}
  )`;
  const managedUsers=`(
    SELECT COALESCE(SUM(server_load.managed_users),0)
    FROM (
      SELECT occupancy_server.id,COUNT(DISTINCT capacity_account.customer_id) AS managed_users
      FROM jellyfin_servers occupancy_server
      LEFT JOIN jellyfin_accounts capacity_account ON capacity_account.server_id=occupancy_server.id
        AND capacity_account.disabled=FALSE AND capacity_account.account_purpose='jellyfin'
      WHERE COALESCE(occupancy_server.media_server_type,'jellyfin')='jellyfin'
        AND occupancy_server.max_users IS NOT NULL
        AND ${planPoolServerSql(alias,'occupancy_server')}
        AND occupancy_server.enabled=TRUE
        AND occupancy_server.allow_new_users=TRUE
        AND COALESCE(occupancy_server.placement_mode,'active')='active'
        AND ${healthFor('occupancy_server')}
        AND ${admissionFor('occupancy_server')}
      GROUP BY occupancy_server.id
    ) server_load
  )`;
  const pendingUsers=`(
    SELECT COUNT(DISTINCT pending_subscription.customer_id)
    FROM subscriptions pending_subscription
    JOIN plans pending_plan ON pending_plan.id=pending_subscription.plan_id
    LEFT JOIN customer_entitlement_overrides pending_override ON pending_override.customer_id=pending_subscription.customer_id AND pending_override.subscription_id=pending_subscription.id
    WHERE pending_subscription.superseded_by IS NULL
      AND pending_subscription.starts_at<=NOW()
      AND COALESCE(NULLIF(pending_subscription.service_type_snapshot,''),pending_plan.service_type,'jellyfin') IN('jellyfin','bundle')
      AND ${planPoolOverlapSql(alias,'pending_plan')}
      AND (
        (pending_override.permanent_access=TRUE AND pending_override.revoked_at IS NULL)
        OR (pending_subscription.status IN('active','trialing','past_due','paused') AND pending_subscription.current_period_end>NOW())
        OR (COALESCE(pending_subscription.service_extension_days,0)>0 AND pending_subscription.status IN('active','trialing','past_due','paused','cancelled','expired') AND (pending_subscription.current_period_end+((pending_subscription.service_extension_days||' days')::interval))>NOW())
      )
      AND NOT public.subscription_admin_removed(pending_subscription.customer_id,'jellyfin')
      AND (
        (
          COALESCE(pending_plan.is_free_tier,FALSE)=TRUE
          AND ${freePendingUnblockedSql('pending_subscription','free_pending_hold')}
        )
        OR (
          COALESCE(pending_plan.is_free_tier,FALSE)=FALSE
          AND NOT EXISTS(
            SELECT 1 FROM customer_access_holds pending_hold
            WHERE pending_hold.customer_id=pending_subscription.customer_id
              AND pending_hold.hold_type IN('inactivity_policy','jellyfin_cleanup')
              AND pending_hold.released_at IS NULL
          )
        )
      )
      AND NOT EXISTS(
        SELECT 1 FROM jellyfin_accounts existing_account
        JOIN jellyfin_servers existing_server ON existing_server.id=existing_account.server_id
        WHERE existing_account.customer_id=pending_subscription.customer_id
          AND existing_account.disabled=FALSE
          AND existing_account.account_purpose='jellyfin'
          AND COALESCE(existing_server.media_server_type,'jellyfin')='jellyfin'
          AND ${planPoolServerSql(alias,'existing_server')}
      )
  )`;
  const checkoutHold=checkoutReservationSql('capacity_checkout');
  const checkoutHolds=`(
    SELECT COUNT(*)
    FROM billing_checkout_intents capacity_checkout
    JOIN plans checkout_plan ON checkout_plan.id=capacity_checkout.plan_id
    WHERE ${checkoutHold}
      AND checkout_plan.service_type IN('jellyfin','bundle')
      AND ${planPoolOverlapSql(alias,'checkout_plan')}
  )`;
  const freeHolds=`(
    SELECT COUNT(*)
    FROM free_access_registration_reservations capacity_free_hold
    JOIN plans free_plan ON free_plan.id=capacity_free_hold.plan_id
    WHERE capacity_free_hold.consumed_at IS NULL
      AND capacity_free_hold.released_at IS NULL
      AND capacity_free_hold.expires_at>NOW()
      AND free_plan.service_type IN('jellyfin','bundle')
      AND ${planPoolOverlapSql(alias,'free_plan')}
  )`;
  return `(${userCapacity} >= (${managedUsers} + ${pendingUsers} + ${checkoutHolds} + ${freeHolds} + 1))`;
}
function acquisitionSql(alias='p'){
  const fleetPlan=`(${alias}.service_type IN('jellyfin','bundle'))`,fleetConfigured=fleetConfiguredSql(alias),fleetAvailable=fleetAvailableSql(alias),manualAvailable=legacyAcquisitionSql(alias);
  const planLimitAvailable=mediaPlanLimitAvailableSql(alias);return `((NOT ${fleetPlan} AND ${manualAvailable}) OR (${fleetPlan} AND ${fleetConfigured} AND ${fleetAvailable} AND ${planLimitAvailable}))`;
}

module.exports={LIVE_STATUSES,usage,assertAvailable,lockAndAssert,acquisitionSql,legacyAcquisitionSql,capacityModel,scarcity,isFleetJellyfin,stremioHouseholdUsage,checkoutReservationSql,freePendingUnblockedSql,managedMediaLimit};
