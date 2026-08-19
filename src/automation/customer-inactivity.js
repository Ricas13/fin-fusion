'use strict';

const {query,transaction}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const planPolicy=require('../entitlements/plan-lifecycle-policy');
const provisioning=require('../jellyfin/provisioning');
const registry=require('../jellyfin/registry');

const KEY='customer_inactivity_policy_v1'; // legacy setting retained for compatibility/read-only migration history
const CLEANUP_KEY='jellyfin_user_cleanup_v1';
const HOLD_TYPE='inactivity_policy';
const CLEANUP_HOLD_TYPE='jellyfin_cleanup';
const DEFAULT_CLEANUP=Object.freeze({enabled:false,dryRun:true,deleteAfterDays:30,minimumObservationHours:24});

function bool(v){return v===true||['true','1','on','yes'].includes(String(v||'').toLowerCase());}
function integer(v,min,max,fallback){const n=Number.parseInt(v,10);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function normalizeCleanup(value={}){return{enabled:bool(value.enabled),dryRun:value.dryRun===undefined?true:bool(value.dryRun),deleteAfterDays:integer(value.deleteAfterDays,1,3650,DEFAULT_CLEANUP.deleteAfterDays),minimumObservationHours:integer(value.minimumObservationHours,1,24*90,DEFAULT_CLEANUP.minimumObservationHours)};}
async function getCleanup(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[CLEANUP_KEY]);return normalizeCleanup({...DEFAULT_CLEANUP,...(r.rows[0]?.setting_value||{})});}
async function saveCleanup(input,actorUserId=null){const value=normalizeCleanup(input);await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[CLEANUP_KEY,JSON.stringify(value),actorUserId]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.jellyfin_cleanup_policy.update','platform_setting',$2,$3::jsonb)`,[actorUserId,CLEANUP_KEY,JSON.stringify(value)])});return value;}

async function telemetryReady(){
  const [worker,servers]=await Promise.all([
    query(`SELECT EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at)) age_seconds FROM operational_worker_state WHERE worker_key='activity'`),
    query(`SELECT COUNT(*)::int enabled,COUNT(*) FILTER(WHERE health_status='offline' OR last_health_check IS NULL OR last_health_check<NOW()-INTERVAL '10 minutes')::int unsafe FROM jellyfin_servers WHERE enabled=TRUE`)
  ]);
  const age=Number(worker.rows[0]?.age_seconds??Infinity),enabled=Number(servers.rows[0]?.enabled||0),unsafe=Number(servers.rows[0]?.unsafe||0);
  return{ready:Number.isFinite(age)&&age<120&&enabled>0&&unsafe===0,activityWorkerAgeSeconds:Number.isFinite(age)?Math.round(age):null,enabledServers:enabled,unsafeServers:unsafe};
}

async function candidates(){
  const result=await query(`
    WITH current_access AS (
      SELECT DISTINCT ON (s.customer_id)
        s.customer_id,s.plan_id,s.starts_at,s.current_period_end,p.code plan_code,p.name plan_name,
        p.price_minor,p.service_type,p.inactivity_policy
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused')
        AND s.starts_at<=NOW() AND s.current_period_end>NOW()
        AND p.price_minor=0 AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND COALESCE((p.inactivity_policy->>'enabled')::boolean,FALSE)=TRUE
      ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
    ), accounts AS (
      SELECT customer_id,MIN(created_at) first_account_at,
             COUNT(*) FILTER(WHERE disabled=FALSE AND account_purpose='jellyfin')::int active_accounts
      FROM jellyfin_accounts GROUP BY customer_id
    )
    SELECT ca.*,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,c.automation_protected,
      us.last_playback_at,COALESCE(us.playback_seconds,0)::bigint playback_seconds,
      a.first_account_at,a.active_accounts,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=ca.customer_id) currently_playing,
      EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=ca.customer_id AND h.hold_type=$1 AND h.source_key=('plan:'||ca.plan_id::text) AND h.released_at IS NULL) already_held
    FROM current_access ca
    JOIN customers c ON c.id=ca.customer_id LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN accounts a ON a.customer_id=ca.customer_id
    LEFT JOIN LATERAL (
      SELECT MAX(COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)) last_playback_at,
             COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at))))
               FILTER(WHERE ph.started_at>=NOW()-(COALESCE(NULLIF(ca.inactivity_policy->>'playbackWindowDays','')::int,7)||' days')::interval),0)::bigint playback_seconds
      FROM playback_history ph WHERE ph.customer_id=ca.customer_id
    ) us ON TRUE
    WHERE COALESCE(a.active_accounts,0)>0
      AND NOT EXISTS(SELECT 1 FROM customer_bans b WHERE b.customer_id=ca.customer_id AND b.revoked_at IS NULL AND b.blocks_service_access=TRUE)
    ORDER BY COALESCE(us.last_playback_at,a.first_account_at,c.created_at),customer_name
  `,[HOLD_TYPE]);
  return result.rows.map(row=>{
    const policy=planPolicy.normalize(row.inactivity_policy||{}),now=Date.now();
    const reference=row.last_playback_at||row.first_account_at||row.starts_at;
    const referenceAt=reference?new Date(reference):null,firstAt=new Date(row.first_account_at||row.starts_at||0),ageHours=(now-firstAt.getTime())/3600000,seconds=Number(row.playback_seconds||0);
    const noPlaybackEligible=policy.noPlaybackDays!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.noPlaybackDays*24)&&referenceAt&&referenceAt.getTime()<=now-policy.noPlaybackDays*86400000;
    const usageEligible=policy.minimumPlaybackMinutes!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.playbackWindowDays*24)&&seconds<policy.minimumPlaybackMinutes*60;
    const eligible=!row.automation_protected&&!row.currently_playing&&!row.already_held&&(noPlaybackEligible||usageEligible);
    const triggers=[];if(noPlaybackEligible)triggers.push(`no playback for ${policy.noPlaybackDays} day(s)`);if(usageEligible)triggers.push(`${Math.round(seconds/60)} min played in ${policy.playbackWindowDays} day(s), below ${policy.minimumPlaybackMinutes} min`);
    return{...row,policy,playback_seconds:seconds,inactive_reference_at:referenceAt,eligible,triggers,reasons:eligible?triggers:[row.automation_protected?'admin protected':null,row.currently_playing?'currently playing':null,row.already_held?'already held':null,!noPlaybackEligible&&!usageEligible?'usage requirements currently satisfied':null].filter(Boolean)};
  });
}

async function releaseObsoletePlanHolds(actorUserId=null){
  const rows=await query(`
    SELECT h.customer_id,h.source_key
    FROM customer_access_holds h
    WHERE h.hold_type=$1 AND h.released_at IS NULL
      AND NOT EXISTS(
        SELECT 1 FROM effective_customer_entitlements e JOIN plans p ON p.id=e.plan_id
        WHERE e.customer_id=h.customer_id AND h.source_key=('plan:'||p.id::text)
          AND p.price_minor=0 AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
          AND COALESCE((p.inactivity_policy->>'enabled')::boolean,FALSE)=TRUE
      )
  `,[HOLD_TYPE]);
  for(const row of rows.rows){await accessHolds.releaseHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:row.source_key,actorUserId});await provisioning.reconcileCustomer(row.customer_id).catch(()=>{});}
  return rows.rowCount;
}

async function runPlanRules({actorUserId=null,forceDryRun=null}={}){
  const telemetry=await telemetryReady();if(!telemetry.ready)return{processed:0,eligible:0,enforced:0,dryRun:true,skipped:'telemetry_not_trustworthy',telemetry};
  const released=await releaseObsoletePlanHolds(actorUserId),rows=await candidates(),eligible=rows.filter(x=>x.eligible);let enforced=0,wouldDisable=0;
  for(const row of eligible){
    const dryRun=forceDryRun===null?row.policy.dryRun:Boolean(forceDryRun),evidence={planId:row.plan_id,planCode:row.plan_code,lastPlaybackAt:row.last_playback_at||null,inactiveReferenceAt:row.inactive_reference_at,playbackMinutes:Math.round(row.playback_seconds/60),triggers:row.triggers,dryRun,portalAccountPreserved:true};
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,dryRun?'customer.inactivity.would_disable_jellyfin':'customer.inactivity.disable_jellyfin',row.customer_id,JSON.stringify(evidence)]);
    if(dryRun){wouldDisable++;continue;}
    await accessHolds.addHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:`plan:${row.plan_id}`,reason:`Free-plan Jellyfin usage rule: ${row.triggers.join('; ')}`,actorUserId,metadata:evidence});
    await provisioning.reconcileCustomer(row.customer_id);enforced++;
  }
  return{processed:rows.length,eligible:eligible.length,enforced,wouldDisable,released,dryRun:eligible.every(x=>forceDryRun===true||x.policy.dryRun),telemetry,examples:eligible.slice(0,25).map(x=>({customerId:x.customer_id,name:x.customer_name,plan:x.plan_code,triggers:x.triggers,lastPlaybackAt:x.last_playback_at,playbackMinutes:Math.round(x.playback_seconds/60)}))};
}

async function cleanupCandidates(cfg=null){
  cfg=cfg||await getCleanup();const cutoff=new Date(Date.now()-cfg.deleteAfterDays*86400000),minimumCreated=new Date(Date.now()-cfg.minimumObservationHours*3600000);
  const r=await query(`
    SELECT ja.id account_id,ja.customer_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,ja.created_at,ja.last_activity_at,
      js.name server_name,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,c.automation_protected,
      ph.last_playback_at,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=ja.customer_id AND aps.server_id=ja.server_id) currently_playing,
      EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=ja.customer_id AND h.hold_type=$3 AND h.source_key=('server:'||ja.server_id::text) AND h.released_at IS NULL) already_held
    FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id JOIN customers c ON c.id=ja.customer_id LEFT JOIN app_users u ON u.id=c.user_id
    LEFT JOIN LATERAL (SELECT MAX(COALESCE(ended_at,last_seen_at,started_at)) last_playback_at FROM playback_history WHERE customer_id=ja.customer_id AND server_id=ja.server_id) ph ON TRUE
    WHERE ja.account_purpose='jellyfin' AND ja.created_at<=$2
      AND GREATEST(COALESCE(ph.last_playback_at,'epoch'::timestamptz),COALESCE(ja.last_activity_at,'epoch'::timestamptz),ja.created_at)<=$1
    ORDER BY GREATEST(COALESCE(ph.last_playback_at,'epoch'::timestamptz),COALESCE(ja.last_activity_at,'epoch'::timestamptz),ja.created_at)
  `,[cutoff,minimumCreated,CLEANUP_HOLD_TYPE]);
  return r.rows.map(row=>({...row,activity_reference_at:[row.last_playback_at,row.last_activity_at,row.created_at].filter(Boolean).map(v=>new Date(v)).sort((a,b)=>b-a)[0]||null,eligible:!row.automation_protected&&!row.currently_playing&&!row.already_held,reasons:[row.automation_protected?'admin protected':null,row.currently_playing?'currently playing':null,row.already_held?'cleanup already recorded':null].filter(Boolean)}));
}

async function deleteDormantAccount(row,{actorUserId=null,dryRun=true,deleteAfterDays=30}={}){
  const evidence={accountId:row.account_id,serverId:row.server_id,serverName:row.server_name,jellyfinUsername:row.jellyfin_username,activityReferenceAt:row.activity_reference_at,deleteAfterDays,dryRun,portalAccountPreserved:true};
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'jellyfin_account',$3,$4::jsonb)`,[actorUserId,dryRun?'jellyfin.cleanup.would_delete':'jellyfin.cleanup.delete',row.account_id,JSON.stringify(evidence)]);
  if(dryRun)return false;
  const sourceKey=`server:${row.server_id}`;
  await accessHolds.addHold({customerId:row.customer_id,type:CLEANUP_HOLD_TYPE,sourceKey,reason:`Dormant Jellyfin user removed after ${deleteAfterDays} inactive day(s)`,actorUserId,metadata:evidence});
  try{
    await registry.request(row.server_id,`/Users/${encodeURIComponent(row.jellyfin_user_id)}`,{method:'DELETE'});
  }catch(error){
    const message=String(error?.message||error);if(!/\b404\b|not found/i.test(message)){await accessHolds.releaseHold({customerId:row.customer_id,type:CLEANUP_HOLD_TYPE,sourceKey,actorUserId}).catch(()=>{});throw error;}
  }
  await query('DELETE FROM jellyfin_accounts WHERE id=$1',[row.account_id]);
  return true;
}

async function runCleanup({actorUserId=null,forceDryRun=null}={}){
  const cfg=await getCleanup(),telemetry=await telemetryReady();if(!cfg.enabled)return{processed:0,eligible:0,deleted:0,dryRun:true,skipped:'cleanup_disabled',telemetry};if(!telemetry.ready)return{processed:0,eligible:0,deleted:0,dryRun:true,skipped:'telemetry_not_trustworthy',telemetry};
  const dryRun=forceDryRun===null?cfg.dryRun:Boolean(forceDryRun),rows=await cleanupCandidates(cfg),eligible=rows.filter(x=>x.eligible);let deleted=0,failed=0;
  for(const row of eligible){try{if(await deleteDormantAccount(row,{actorUserId,dryRun,deleteAfterDays:cfg.deleteAfterDays}))deleted++;}catch(error){failed++;console.error('Dormant Jellyfin cleanup failed:',{accountId:row.account_id,error:String(error?.message||error).slice(0,500)});}}
  return{processed:rows.length,eligible:eligible.length,deleted,failed,dryRun,telemetry,examples:eligible.slice(0,25).map(x=>({customerId:x.customer_id,name:x.customer_name,server:x.server_name,jellyfinUsername:x.jellyfin_username,activityReferenceAt:x.activity_reference_at}))};
}

async function restoreReturningCustomer(customerId){
  const holds=await query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL ORDER BY created_at`,[customerId,CLEANUP_HOLD_TYPE]);if(!holds.rowCount)return{restored:false};
  const entitlement=await provisioning.currentEntitlement(customerId);if(!entitlement||!['jellyfin','bundle'].includes(String(entitlement.service_type_snapshot||entitlement.service_type||'jellyfin')))return{restored:false,reason:'no_jellyfin_entitlement'};
  for(const row of holds.rows)await accessHolds.releaseHold({customerId,type:CLEANUP_HOLD_TYPE,sourceKey:row.source_key});
  await provisioning.reconcileCustomer(customerId);
  await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({releasedCleanupHolds:holds.rowCount,portalReturn:true})]);
  return{restored:true,released:holds.rowCount};
}

async function run(options={}){const [planRules,cleanup]=await Promise.all([runPlanRules(options),runCleanup(options)]);return{processed:Number(planRules.processed||0)+Number(cleanup.processed||0),planRules,cleanup};}

// Compatibility: the old global Free-plan policy API now reports that rules
// live on the plan itself. Existing callers can still import these names.
function normalize(){return{enabled:false,deprecated:true};}
async function get(){return{enabled:false,deprecated:true,message:'Free-plan inactivity rules are configured on each plan.'};}
async function save(){throw new Error('Free-plan inactivity rules are now configured on each plan.');}

module.exports={KEY,CLEANUP_KEY,HOLD_TYPE,CLEANUP_HOLD_TYPE,DEFAULT_CLEANUP,normalize,get,save,normalizeCleanup,getCleanup,saveCleanup,telemetryReady,candidates,cleanupCandidates,runPlanRules,runCleanup,restoreReturningCustomer,run};
