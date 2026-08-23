'use strict';

const {query}=require('../db');

const LIVE_STATUSES=['active','trialing','past_due','paused'];
const RESERVATION_SQL=`consumed_at IS NULL AND released_at IS NULL AND expires_at>NOW()`;
const FLEET_CLASSES=new Set(['premium','free']);

function positiveInt(value,fallback=1){const n=Number(value);return Number.isInteger(n)&&n>0?n:fallback;}
function serviceType(plan){return String(plan?.service_type||'').toLowerCase();}
function serverClass(plan){return String(plan?.server_class||'').toLowerCase();}
function isTrial(plan){return String(plan?.billing_interval||'').toLowerCase()==='trial';}
function isFleetJellyfin(plan){return serviceType(plan)==='jellyfin'&&FLEET_CLASSES.has(serverClass(plan));}
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
async function loadPlan(planId,db=query){
  const result=await db(`SELECT id,capacity_limit,service_type,server_class,billing_interval,price_minor,is_free_tier,streams FROM plans WHERE id=$1`,[planId]);
  if(!result.rowCount)throw new Error('Plan not found.');
  return result.rows[0];
}
async function legacyUsage(plan,db=query,{excludeReservationId=null}={}){
  const result=await db(`SELECT
      (SELECT COUNT(DISTINCT s.customer_id)::int FROM subscriptions s WHERE s.plan_id=$1 AND s.superseded_by IS NULL AND s.status=ANY($2::text[]) AND s.starts_at<=NOW() AND s.current_period_end>NOW()) AS used,
      (SELECT COUNT(*)::int FROM free_access_registration_reservations r WHERE r.plan_id=$1 AND ${RESERVATION_SQL} AND ($3::uuid IS NULL OR r.id<>$3::uuid)) AS reserved`,[plan.id,LIVE_STATUSES,excludeReservationId]);
  const row=result.rows[0]||{},limit=plan.capacity_limit==null?null:Number(plan.capacity_limit),used=Number(row.used||0),reserved=Number(row.reserved||0),occupied=used+reserved;
  const state={planId:plan.id,plan,model:'manual_plan',pool:null,limit,used,reserved,remaining:limit==null?null:Math.max(0,limit-occupied),soldOut:limit!=null&&occupied>=limit,manualLimit:limit,manualUsed:used,manualReserved:reserved};
  return{...state,...scarcity(state)};
}
function eligibleServerClause(plan){
  const cls=serverClass(plan);
  if(cls==='free')return`js.server_class='free'`;
  if(isTrial(plan))return`js.server_class='premium' AND js.trial_enabled=TRUE`;
  return`js.server_class='premium' AND js.paid_enabled=TRUE`;
}
async function fleetStreams(plan,db=query,{excludeReservationId=null}={}){
  const cls=serverClass(plan),serverClause=eligibleServerClause(plan);
  const configured=await db(`SELECT COUNT(*) FILTER(WHERE js.max_users IS NOT NULL)::int configured_servers,COALESCE(SUM(js.max_users) FILTER(WHERE js.max_users IS NOT NULL),0)::int stream_limit
    FROM jellyfin_servers js WHERE js.enabled=TRUE AND js.allow_new_users=TRUE AND COALESCE(js.placement_mode,'active')='active' AND ${serverClause}`);
  const configuredServers=Number(configured.rows[0]?.configured_servers||0),streamLimit=Number(configured.rows[0]?.stream_limit||0);
  if(!configuredServers)return null;
  const used=await db(`SELECT COALESCE(SUM(GREATEST(1,COALESCE(CASE WHEN jsonb_typeof(s.commercial_snapshot->'streams')='number' THEN (s.commercial_snapshot->>'streams')::int END,p.streams,1))),0)::int AS stream_used
    FROM subscriptions s JOIN plans p ON p.id=s.plan_id
    WHERE s.superseded_by IS NULL AND s.status=ANY($2::text[]) AND s.starts_at<=NOW() AND s.current_period_end>NOW()
      AND p.service_type IN('jellyfin','bundle') AND p.server_class=$1`,[cls,LIVE_STATUSES]);
  const checkout=await db(`SELECT COALESCE(SUM(GREATEST(1,COALESCE(CASE WHEN jsonb_typeof(i.commercial_snapshot->'streams')='number' THEN (i.commercial_snapshot->>'streams')::int END,p.streams,1))),0)::int AS stream_reserved
    FROM billing_checkout_intents i JOIN plans p ON p.id=i.plan_id
    WHERE i.state='open' AND i.expires_at>NOW() AND p.service_type IN('jellyfin','bundle') AND p.server_class=$1`,[cls]);
  const freeHolds=await db(`SELECT COALESCE(SUM(GREATEST(1,COALESCE(p.streams,1))),0)::int AS stream_reserved
    FROM free_access_registration_reservations r JOIN plans p ON p.id=r.plan_id
    WHERE ${RESERVATION_SQL} AND p.service_type='jellyfin' AND p.server_class=$1 AND ($2::uuid IS NULL OR r.id<>$2::uuid)`,[cls,excludeReservationId]);
  const streamUsed=Number(used.rows[0]?.stream_used||0),streamReserved=Number(checkout.rows[0]?.stream_reserved||0)+Number(freeHolds.rows[0]?.stream_reserved||0),streamRemaining=Math.max(0,streamLimit-streamUsed-streamReserved);
  return{pool:cls,configuredServers,streamLimit,streamUsed,streamReserved,streamRemaining};
}
async function usage(planId,db=query,{excludeReservationId=null,streams=null}={}){
  const plan=await loadPlan(planId,db),model=capacityModel(plan);
  if(model!=='fleet_streams')return legacyUsage(plan,db,{excludeReservationId});
  const fleet=await fleetStreams(plan,db,{excludeReservationId});
  if(!fleet){
    const legacy=await legacyUsage(plan,db,{excludeReservationId});
    return{...legacy,model:'legacy_plan',fallbackReason:'No eligible server stream capacity is configured.'};
  }
  const requiredStreams=positiveInt(streams,positiveInt(plan.streams,1)),fleetLimit=Math.floor(fleet.streamLimit/requiredStreams),fleetRemaining=Math.floor(fleet.streamRemaining/requiredStreams),fleetUsed=Math.max(0,fleetLimit-fleetRemaining);
  let remaining=fleetRemaining,limit=fleetLimit,manualLimit=null,manualUsed=0,manualReserved=0;
  if(isTrial(plan)){
    const manual=await legacyUsage(plan,db,{excludeReservationId});
    manualLimit=manual.limit;manualUsed=manual.used;manualReserved=manual.reserved;
    if(manual.remaining!=null)remaining=Math.min(remaining,manual.remaining);
    if(manual.limit!=null)limit=Math.min(limit,manual.limit);
  }
  const state={planId:plan.id,plan,model:'fleet_streams',pool:fleet.pool,configuredServers:fleet.configuredServers,requiredStreams,streamLimit:fleet.streamLimit,streamUsed:fleet.streamUsed,streamReserved:fleet.streamReserved,streamRemaining:fleet.streamRemaining,limit,used:fleetUsed,reserved:0,remaining,soldOut:remaining<=0,manualLimit,manualUsed,manualReserved};
  return{...state,...scarcity(state)};
}

async function assertAvailable(planId,{db=query,label='This plan',excludeReservationId=null,streams=null}={}){
  const state=await usage(planId,db,{excludeReservationId,streams});
  if(state.soldOut)throw new Error(`${label} is currently sold out.`);
  return state;
}

async function lockAndAssert(client,planId,label='This plan',{excludeReservationId=null,streams=null}={}){
  const plan=await loadPlan(planId,(sql,params)=>client.query(sql,params)),model=capacityModel(plan),key=model==='fleet_streams'?`fleet:${serverClass(plan)}`:`plan:${planId}`;
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('captainfin:capacity:'||$1::text, 77133))`,[key]);
  return assertAvailable(planId,{db:(sql,params)=>client.query(sql,params),label,excludeReservationId,streams});
}

function legacyAcquisitionSql(alias='p'){
  return `(${alias}.capacity_limit IS NULL OR ${alias}.capacity_limit > ((
    SELECT COUNT(DISTINCT cs.customer_id) FROM subscriptions cs
    WHERE cs.plan_id=${alias}.id AND cs.superseded_by IS NULL
      AND cs.status IN ('active','trialing','past_due','paused')
      AND cs.starts_at<=NOW() AND cs.current_period_end>NOW()
  ) + (
    SELECT COUNT(*) FROM free_access_registration_reservations cr
    WHERE cr.plan_id=${alias}.id AND cr.consumed_at IS NULL AND cr.released_at IS NULL AND cr.expires_at>NOW()
  )))`;
}
function acquisitionSql(alias='p'){
  const fleetConfigured=`(${alias}.service_type='jellyfin' AND ${alias}.billing_interval<>'trial' AND ${alias}.server_class IN('premium','free') AND EXISTS(
    SELECT 1 FROM jellyfin_servers capacity_server
    WHERE capacity_server.enabled=TRUE AND capacity_server.allow_new_users=TRUE AND COALESCE(capacity_server.placement_mode,'active')='active'
      AND capacity_server.server_class=${alias}.server_class AND capacity_server.max_users IS NOT NULL
      AND (${alias}.server_class='free' OR capacity_server.paid_enabled=TRUE)
  ))`;
  return `(${fleetConfigured} OR ${legacyAcquisitionSql(alias)})`;
}

module.exports={LIVE_STATUSES,usage,assertAvailable,lockAndAssert,acquisitionSql,legacyAcquisitionSql,capacityModel,scarcity,isFleetJellyfin};
