'use strict';

const {query,transaction}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const provisioning=require('../jellyfin/provisioning');
const KEY='customer_inactivity_policy_v1';
const HOLD_TYPE='inactivity_policy';
const HOLD_SOURCE='automatic_free_inactivity';
const DEFAULTS=Object.freeze({enabled:false,planCodes:['trial-24h'],inactiveDays:7,minimumPlaybackMinutes:0,action:'disable_jellyfin',dryRun:true,minimumObservationHours:24});
function bool(v){return v===true||v==='true'||v==='1'||v==='on'}
function integer(v,min,max,fallback){const n=Number.parseInt(v,10);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback}
function planCodes(v){const rows=Array.isArray(v)?v:String(v||'').split(/[\n,]/);return [...new Set(rows.map(x=>String(x||'').trim().toLowerCase()).filter(x=>/^[a-z0-9][a-z0-9-]{1,49}$/.test(x)))].slice(0,50)}
function normalize(value={}){return{enabled:bool(value.enabled),planCodes:planCodes(value.planCodes).length?planCodes(value.planCodes):DEFAULTS.planCodes,inactiveDays:integer(value.inactiveDays,1,365,DEFAULTS.inactiveDays),minimumPlaybackMinutes:integer(value.minimumPlaybackMinutes,0,100000,DEFAULTS.minimumPlaybackMinutes),action:'disable_jellyfin',dryRun:value.dryRun===undefined?true:bool(value.dryRun),minimumObservationHours:integer(value.minimumObservationHours,1,24*30,DEFAULTS.minimumObservationHours)}}
async function get(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[KEY]);return normalize({...DEFAULTS,...(r.rows[0]?.setting_value||{})});}
async function save(input,actorUserId=null){const value=normalize(input);await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[KEY,JSON.stringify(value),actorUserId]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.inactivity_policy.update','platform_setting',$2,$3::jsonb)`,[actorUserId,KEY,JSON.stringify(value)])});return value;}
async function telemetryReady(){
  const [worker,servers]=await Promise.all([
    query(`SELECT EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at)) age_seconds FROM operational_worker_state WHERE worker_key='activity'`),
    query(`SELECT COUNT(*)::int enabled,COUNT(*) FILTER(WHERE health_status='offline' OR last_health_check IS NULL OR last_health_check<NOW()-INTERVAL '10 minutes')::int unsafe FROM jellyfin_servers WHERE enabled=TRUE`)
  ]);
  const age=Number(worker.rows[0]?.age_seconds??Infinity),enabled=Number(servers.rows[0]?.enabled||0),unsafe=Number(servers.rows[0]?.unsafe||0);
  return{ready:Number.isFinite(age)&&age<120&&enabled>0&&unsafe===0,activityWorkerAgeSeconds:Number.isFinite(age)?Math.round(age):null,enabledServers:enabled,unsafeServers:unsafe};
}
async function candidates(cfg=await get()){
  const lookbackDays=Math.max(cfg.inactiveDays,1),minimumCreated=new Date(Date.now()-cfg.minimumObservationHours*3600000);
  const result=await query(`
    WITH current_access AS (
      SELECT DISTINCT ON (s.customer_id)
        s.customer_id,s.plan_id,s.starts_at,s.current_period_end,p.code plan_code,p.name plan_name
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused')
        AND s.starts_at<=NOW() AND s.current_period_end>NOW()
      ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
    ), usage AS (
      SELECT customer_id,
        MAX(COALESCE(ended_at,last_seen_at,started_at)) last_playback_at,
        COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ended_at,last_seen_at)-started_at)))) FILTER(WHERE started_at>=NOW()-($2::int||' days')::interval),0)::bigint playback_seconds
      FROM playback_history
      WHERE customer_id IS NOT NULL
      GROUP BY customer_id
    ), accounts AS (
      SELECT customer_id,MIN(created_at) first_account_at,COUNT(*) FILTER(WHERE disabled=FALSE AND account_purpose='primary')::int active_accounts
      FROM jellyfin_accounts GROUP BY customer_id
    )
    SELECT ca.customer_id,ca.plan_code,ca.plan_name,ca.starts_at,ca.current_period_end,
      COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,
      us.last_playback_at,COALESCE(us.playback_seconds,0)::bigint playback_seconds,
      a.first_account_at,a.active_accounts,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=ca.customer_id) currently_playing,
      EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=ca.customer_id AND h.hold_type=$4 AND h.source_key=$5 AND h.released_at IS NULL) already_held
    FROM current_access ca
    JOIN customers c ON c.id=ca.customer_id LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN usage us ON us.customer_id=ca.customer_id LEFT JOIN accounts a ON a.customer_id=ca.customer_id
    WHERE ca.plan_code=ANY($1::text[])
      AND COALESCE(a.active_accounts,0)>0
      AND COALESCE(a.first_account_at,c.created_at)<=$3
      AND NOT EXISTS(SELECT 1 FROM customer_bans b WHERE b.customer_id=ca.customer_id AND b.revoked_at IS NULL AND b.blocks_service_access=TRUE)
    ORDER BY COALESCE(us.last_playback_at,a.first_account_at,c.created_at),customer_name
  `,[cfg.planCodes,lookbackDays,minimumCreated,HOLD_TYPE,HOLD_SOURCE]);
  const cutoff=Date.now()-cfg.inactiveDays*86400000,maxSeconds=cfg.minimumPlaybackMinutes*60;
  return result.rows.map(row=>{
    const reference=row.last_playback_at||row.first_account_at||row.starts_at;
    const inactiveSince=reference?new Date(reference):null,seconds=Number(row.playback_seconds||0);
    const eligible=!row.currently_playing&&!row.already_held&&inactiveSince&&inactiveSince.getTime()<=cutoff&&seconds<=maxSeconds;
    const reasons=[];if(row.currently_playing)reasons.push('currently playing');if(row.already_held)reasons.push('already held');if(!inactiveSince||inactiveSince.getTime()>cutoff)reasons.push('recent activity');if(seconds>maxSeconds)reasons.push(`${Math.round(seconds/60)} playback minutes in window`);
    return{...row,playback_seconds:seconds,inactive_reference_at:inactiveSince,eligible,reasons};
  });
}
async function run({actorUserId=null,forceDryRun=null}={}){
  const cfg=await get(),telemetry=await telemetryReady();
  if(!cfg.enabled)return{processed:0,eligible:0,enforced:0,dryRun:true,skipped:'policy_disabled',telemetry};
  if(!telemetry.ready)return{processed:0,eligible:0,enforced:0,dryRun:true,skipped:'telemetry_not_trustworthy',telemetry};
  const dryRun=forceDryRun===null?cfg.dryRun:Boolean(forceDryRun),rows=await candidates(cfg),eligible=rows.filter(x=>x.eligible);let enforced=0;
  for(const row of eligible){
    const evidence={planCode:row.plan_code,lastPlaybackAt:row.last_playback_at||null,inactiveReferenceAt:row.inactive_reference_at,playbackMinutes:Math.round(row.playback_seconds/60),inactiveDays:cfg.inactiveDays,minimumPlaybackMinutes:cfg.minimumPlaybackMinutes,dryRun};
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,dryRun?'customer.inactivity.would_disable':'customer.inactivity.disable_jellyfin',row.customer_id,JSON.stringify(evidence)]);
    if(dryRun)continue;
    await accessHolds.addHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:HOLD_SOURCE,reason:`Inactive free access: no qualifying use for ${cfg.inactiveDays} day(s)`,actorUserId,metadata:evidence});
    await provisioning.reconcileCustomer(row.customer_id);enforced++;
  }
  return{processed:rows.length,eligible:eligible.length,enforced,dryRun,telemetry,examples:eligible.slice(0,25).map(x=>({customerId:x.customer_id,name:x.customer_name,plan:x.plan_code,lastPlaybackAt:x.last_playback_at,playbackMinutes:Math.round(x.playback_seconds/60)}))};
}
module.exports={KEY,HOLD_TYPE,HOLD_SOURCE,DEFAULTS,normalize,get,save,telemetryReady,candidates,run};
