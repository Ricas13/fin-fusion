'use strict';

const {query,transaction}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const planPolicy=require('../entitlements/plan-lifecycle-policy');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');
const provisioning=require('../jellyfin/resilient-provisioning');
const registry=require('../jellyfin/registry');
const activityTrust=require('../jellyfin/activity-trust');

const KEY='customer_inactivity_policy_v1';
const CLEANUP_KEY='jellyfin_user_cleanup_v1';
const HOLD_TYPE='inactivity_policy';
const CLEANUP_HOLD_TYPE='jellyfin_cleanup';
const DEFAULT_CLEANUP=Object.freeze({enabled:false,dryRun:true,deleteAfterDays:30,minimumObservationHours:24});

function bool(v){return v===true||['true','1','on','yes'].includes(String(v||'').toLowerCase());}
function integer(v,min,max,fallback){const n=Number.parseInt(v,10);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function normalizeCleanup(value={}){return{enabled:bool(value.enabled),dryRun:value.dryRun===undefined?true:bool(value.dryRun),deleteAfterDays:integer(value.deleteAfterDays,1,3650,DEFAULT_CLEANUP.deleteAfterDays),minimumObservationHours:integer(value.minimumObservationHours,1,24*90,DEFAULT_CLEANUP.minimumObservationHours)};}
async function getCleanup(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[CLEANUP_KEY]);return normalizeCleanup({...DEFAULT_CLEANUP,...(r.rows[0]?.setting_value||{})});}
async function saveCleanup(input,actorUserId=null){const value=normalizeCleanup(input);await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[CLEANUP_KEY,JSON.stringify(value),actorUserId]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.jellyfin_cleanup_policy.update','platform_setting',$2,$3::jsonb)`,[actorUserId,CLEANUP_KEY,JSON.stringify(value)])});return value;}

function asDate(value){if(!value)return null;const date=new Date(value);return Number.isFinite(date.getTime())?date:null;}
function earliestDate(values){const dates=values.map(asDate).filter(Boolean);if(!dates.length)return null;return new Date(Math.min(...dates.map(date=>date.getTime())));}
function assessUsage(row,policy,now=Date.now()){
  const lastPlaybackAt=asDate(row.last_playback_at),lastActivityAt=asDate(row.last_activity_at),accountCreatedAt=asDate(row.account_created_at),startsAt=asDate(row.starts_at);
  const referenceAt=lastPlaybackAt||lastActivityAt||accountCreatedAt||startsAt;
  const mappedAt=accountCreatedAt||startsAt;
  const historicalEvidenceAt=earliestDate([lastPlaybackAt,lastActivityAt]);
  const observationStartedAt=earliestDate([mappedAt,historicalEvidenceAt])||referenceAt;
  const ageHours=observationStartedAt?Math.max(0,(now-observationStartedAt.getTime())/3600000):0;
  const seconds=Number(row.playback_seconds||0);
  const noPlaybackEligible=policy.noPlaybackDays!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.noPlaybackDays*24)&&referenceAt&&referenceAt.getTime()<=now-policy.noPlaybackDays*86400000;
  const usageEligible=policy.minimumPlaybackMinutes!=null&&ageHours>=Math.max(policy.minimumObservationHours,policy.playbackWindowDays*24)&&seconds<policy.minimumPlaybackMinutes*60;
  return{referenceAt,observationStartedAt,ageHours,seconds,noPlaybackEligible,usageEligible};
}

async function telemetryReady(serverIds=[]){const ids=[...new Set((serverIds||[]).filter(Boolean).map(String))];if(!ids.length){const worker=await activityTrust.workerTelemetry();return{...worker,targetServers:0,unsafeTargetServers:0,servers:{}};}return activityTrust.telemetryForServers(ids);}

async function candidates(globalCfg=null,{customerId=null}={}){
  globalCfg=globalCfg||await lifecyclePolicy.get();
  if(!globalCfg.enabled)return[];
  const result=await query(`
    WITH free_access AS (
      SELECT DISTINCT ON (s.customer_id)
        s.customer_id,s.id subscription_id,s.plan_id,s.starts_at,s.current_period_end,p.code plan_code,p.name plan_name,p.inactivity_policy
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused')
        AND s.starts_at<=NOW() AND s.current_period_end>NOW()
        AND p.is_free_tier=TRUE AND p.price_minor=0
        AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND ($2::uuid IS NULL OR s.customer_id=$2::uuid)
      ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
    )
    SELECT fa.*,ja.id account_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,ja.created_at account_created_at,ja.last_activity_at,js.name server_name,
      COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,COALESCE(c.email,u.email) email,c.automation_protected,
      us.last_playback_at,COALESCE(us.playback_seconds,0)::bigint playback_seconds,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=fa.customer_id AND aps.server_id=ja.server_id) currently_playing,
      EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=fa.customer_id AND h.hold_type=$1 AND h.source_key=('plan:'||fa.plan_id::text) AND h.released_at IS NULL) already_held
    FROM free_access fa
    JOIN customers c ON c.id=fa.customer_id LEFT JOIN app_users u ON u.id=c.user_id
    JOIN jellyfin_accounts ja ON ja.customer_id=fa.customer_id AND ja.account_purpose='jellyfin' AND ja.access_lane='free' AND ja.disabled=FALSE
    JOIN jellyfin_servers js ON js.id=ja.server_id
    LEFT JOIN LATERAL (
      SELECT MAX(COALESCE(ph.ended_at,ph.last_seen_at,ph.started_at)) last_playback_at,
             COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM (COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at))))
               FILTER(WHERE ph.started_at>=NOW()-(COALESCE(NULLIF(fa.inactivity_policy->>'playbackWindowDays','')::int,7)||' days')::interval),0)::bigint playback_seconds
      FROM playback_history ph
      WHERE ph.customer_id=fa.customer_id AND ph.server_id=ja.server_id
    ) us ON TRUE
    WHERE NOT EXISTS(SELECT 1 FROM customer_bans b WHERE b.customer_id=fa.customer_id AND b.revoked_at IS NULL AND b.blocks_service_access=TRUE)
    ORDER BY COALESCE(us.last_playback_at,ja.last_activity_at,ja.created_at),customer_name
  `,[HOLD_TYPE,customerId||null]);
  return result.rows.map(row=>{
    const policy=planPolicy.effectiveForFreePlan(row.inactivity_policy||{},globalCfg),assessment=assessUsage(row,policy),usageTriggered=planPolicy.usageTriggered(assessment,policy),eligible=policy.enabled&&!row.automation_protected&&!row.currently_playing&&usageTriggered,triggers=[];
    if(assessment.noPlaybackEligible)triggers.push(`no Free Server playback for ${policy.noPlaybackDays} day(s)`);
    if(assessment.usageEligible)triggers.push(`${Math.round(assessment.seconds/60)} min played on Free Server in ${policy.playbackWindowDays} day(s), below ${policy.minimumPlaybackMinutes} min`);
    return{...row,policy,playback_seconds:assessment.seconds,inactive_reference_at:assessment.referenceAt,observation_started_at:assessment.observationStartedAt,eligible,repairExistingHold:Boolean(row.already_held&&eligible),triggers,reasons:eligible?triggers:[!policy.enabled?'Free Server usage rules disabled for this plan':null,row.automation_protected?'admin protected':null,row.currently_playing?'currently playing on Free Server':null,row.already_held?'already held':null,policy.enabled&&!usageTriggered?'Free Server removal requires all configured usage rules to be met':null].filter(Boolean)};
  }).filter(row=>planPolicy.hasUsageTrigger(row.policy));
}

async function releaseObsoletePlanHolds(actorUserId=null,globalCfg=null){globalCfg=globalCfg||await lifecyclePolicy.get();const rows=await query(`SELECT h.customer_id,h.source_key,p.inactivity_policy,p.is_free_tier,p.price_minor,p.service_type,EXISTS(SELECT 1 FROM subscriptions s WHERE s.customer_id=h.customer_id AND s.plan_id=p.id AND s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<=NOW() AND s.current_period_end>NOW()) active_subscription FROM customer_access_holds h LEFT JOIN plans p ON h.source_key=('plan:'||p.id::text) WHERE h.hold_type=$1 AND h.released_at IS NULL`,[HOLD_TYPE]);let released=0;for(const row of rows.rows){const policy=planPolicy.effectiveForFreePlan(row.inactivity_policy||{},globalCfg),keep=Boolean(row.active_subscription&&row.is_free_tier&&Number(row.price_minor||0)===0&&['jellyfin','bundle'].includes(String(row.service_type||'jellyfin'))&&planPolicy.hasUsageTrigger(policy));if(keep)continue;await accessHolds.releaseHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:row.source_key,actorUserId});await provisioning.reconcileCustomer(row.customer_id).catch(()=>{});released++;}return released;}

async function runPlanRules({actorUserId=null,forceDryRun=null}={}){const globalCfg=await lifecyclePolicy.get(),released=await releaseObsoletePlanHolds(actorUserId,globalCfg);if(!globalCfg.enabled)return{processed:0,eligible:0,enforced:0,wouldDisable:0,released,dryRun:true,skipped:'lifecycle_disabled'};const worker=await telemetryReady();if(!worker.ready)return{processed:0,eligible:0,enforced:0,wouldDisable:0,released,dryRun:true,skipped:'telemetry_not_trustworthy',telemetry:worker};const rows=await candidates(globalCfg),serverIds=[...new Set(rows.map(x=>String(x.server_id)))],telemetry=await telemetryReady(serverIds),eligible=rows.filter(x=>x.eligible&&telemetry.servers?.[String(x.server_id)]?.ready);let enforced=0,wouldDisable=0,safetySkipped=rows.filter(x=>x.eligible&&!telemetry.servers?.[String(x.server_id)]?.ready).length;for(const row of eligible){const dryRun=forceDryRun===null?row.policy.dryRun:Boolean(forceDryRun),evidence={planId:row.plan_id,planCode:row.plan_code,accessLane:'free',accountId:row.account_id,serverId:row.server_id,lastPlaybackAt:row.last_playback_at||null,inactiveReferenceAt:row.inactive_reference_at,observationStartedAt:row.observation_started_at,playbackMinutes:Math.round(row.playback_seconds/60),triggers:row.triggers,dryRun,policyInherited:row.policy.inherited,portalAccountPreserved:true,activityPollTrusted:true};await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,dryRun?'customer.inactivity.would_disable_jellyfin':'customer.inactivity.disable_jellyfin',row.customer_id,JSON.stringify(evidence)]);if(dryRun){wouldDisable++;continue;}await accessHolds.addHold({customerId:row.customer_id,type:HOLD_TYPE,sourceKey:`plan:${row.plan_id}`,reason:`Free-plan Jellyfin usage rule: ${row.triggers.join('; ')}`,actorUserId,metadata:evidence});await provisioning.reconcileCustomer(row.customer_id);enforced++;}return{processed:rows.length,eligible:eligible.length,enforced,wouldDisable,safetySkipped,released,dryRun:eligible.every(x=>forceDryRun===true||x.policy.dryRun),telemetry,examples:eligible.slice(0,25).map(x=>({customerId:x.customer_id,name:x.customer_name,plan:x.plan_code,server:x.server_name,triggers:x.triggers,lastPlaybackAt:x.last_playback_at,playbackMinutes:Math.round(x.playback_seconds/60)}))};}

async function cleanupCandidates(cfg=null){cfg=cfg||await getCleanup();const cutoff=new Date(Date.now()-cfg.deleteAfterDays*86400000),minimumCreated=new Date(Date.now()-cfg.minimumObservationHours*3600000);const r=await query(`SELECT ja.id account_id,ja.customer_id,ja.server_id,ja.access_lane,ja.jellyfin_user_id,ja.jellyfin_username,ja.created_at,ja.last_activity_at,js.name server_name,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,c.automation_protected,ph.last_playback_at,EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=ja.customer_id AND aps.server_id=ja.server_id) currently_playing,EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=ja.customer_id AND h.hold_type=$3 AND h.source_key=('server:'||ja.server_id::text) AND h.released_at IS NULL) already_held FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id JOIN customers c ON c.id=ja.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN LATERAL (SELECT MAX(COALESCE(ended_at,last_seen_at,started_at)) last_playback_at FROM playback_history WHERE customer_id=ja.customer_id AND server_id=ja.server_id) ph ON TRUE WHERE ja.account_purpose='jellyfin' AND ja.created_at<=$2 AND GREATEST(COALESCE(ph.last_playback_at,'epoch'::timestamptz),COALESCE(ja.last_activity_at,'epoch'::timestamptz),ja.created_at)<=$1 ORDER BY GREATEST(COALESCE(ph.last_playback_at,'epoch'::timestamptz),COALESCE(ja.last_activity_at,'epoch'::timestamptz),ja.created_at)`,[cutoff,minimumCreated,CLEANUP_HOLD_TYPE]);return r.rows.map(row=>({...row,activity_reference_at:[row.last_playback_at,row.last_activity_at,row.created_at].filter(Boolean).map(v=>new Date(v)).sort((a,b)=>b-a)[0]||null,eligible:!row.automation_protected&&!row.currently_playing&&!row.already_held,reasons:[row.automation_protected?'admin protected':null,row.currently_playing?'currently playing':null,row.already_held?'cleanup already recorded':null].filter(Boolean)}));}

async function deleteDormantAccount(row,{actorUserId=null,dryRun=true,deleteAfterDays=30}={}){const evidence={accountId:row.account_id,serverId:row.server_id,serverName:row.server_name,accessLane:row.access_lane,jellyfinUsername:row.jellyfin_username,activityReferenceAt:row.activity_reference_at,deleteAfterDays,dryRun,portalAccountPreserved:true};await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'jellyfin_account',$3,$4::jsonb)`,[actorUserId,dryRun?'jellyfin.cleanup.would_delete':'jellyfin.cleanup.delete',row.account_id,JSON.stringify(evidence)]);if(dryRun)return false;const sourceKey=`server:${row.server_id}`;await accessHolds.addHold({customerId:row.customer_id,type:CLEANUP_HOLD_TYPE,sourceKey,reason:`Dormant Jellyfin user removed after ${deleteAfterDays} inactive day(s)`,actorUserId,metadata:evidence});try{await registry.request(row.server_id,`/Users/${encodeURIComponent(row.jellyfin_user_id)}`,{method:'DELETE'});}catch(error){const message=String(error?.message||error);if(!/\b404\b|not found/i.test(message)){await accessHolds.releaseHold({customerId:row.customer_id,type:CLEANUP_HOLD_TYPE,sourceKey,actorUserId}).catch(()=>{});throw error;}}await query('DELETE FROM jellyfin_accounts WHERE id=$1',[row.account_id]);return true;}

async function runCleanup({actorUserId=null,forceDryRun=null}={}){const cfg=await getCleanup();if(!cfg.enabled)return{processed:0,eligible:0,deleted:0,dryRun:true,skipped:'cleanup_disabled'};const worker=await telemetryReady();if(!worker.ready)return{processed:0,eligible:0,deleted:0,dryRun:true,skipped:'telemetry_not_trustworthy',telemetry:worker};const dryRun=forceDryRun===null?cfg.dryRun:Boolean(forceDryRun),rows=await cleanupCandidates(cfg),telemetry=await telemetryReady([...new Set(rows.map(x=>String(x.server_id)))]),eligible=rows.filter(x=>x.eligible&&telemetry.servers?.[String(x.server_id)]?.ready);let deleted=0,failed=0;for(const row of eligible){try{if(await deleteDormantAccount(row,{actorUserId,dryRun,deleteAfterDays:cfg.deleteAfterDays}))deleted++;}catch(error){failed++;console.error('Dormant Jellyfin cleanup failed:',{accountId:row.account_id,error:String(error?.message||error).slice(0,500)});}}return{processed:rows.length,eligible:eligible.length,deleted,failed,dryRun,telemetry,examples:eligible.slice(0,25).map(x=>({customerId:x.customer_id,name:x.customer_name,server:x.server_name,accessLane:x.access_lane,jellyfinUsername:x.jellyfin_username,activityReferenceAt:x.activity_reference_at}))};}

async function restoreReturningCustomer(customerId){const holds=await query(`SELECT source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL ORDER BY created_at`,[customerId,CLEANUP_HOLD_TYPE]);if(!holds.rowCount)return{restored:false};const current=await query(`SELECT e.subscription_id,e.source,e.is_free_tier,COALESCE(NULLIF(e.service_type_snapshot,''),e.service_type) service_type FROM effective_customer_entitlements e WHERE e.customer_id=$1 LIMIT 1`,[customerId]),entitlement=current.rows[0]||null;if(entitlement&&!entitlement.is_free_tier&&['jellyfin','bundle'].includes(String(entitlement.service_type||'jellyfin')))return{restored:false,reason:'premium_jellyfin_active'};if(!entitlement||!['jellyfin','bundle'].includes(String(entitlement.service_type||'jellyfin')))return{restored:false,reason:'no_jellyfin_entitlement'};for(const row of holds.rows)await accessHolds.releaseHold({customerId,type:CLEANUP_HOLD_TYPE,sourceKey:row.source_key});await provisioning.reconcileCustomer(customerId);await query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('jellyfin.cleanup.restore_on_portal_return','customer',$1,$2::jsonb)`,[customerId,JSON.stringify({releasedCleanupHolds:holds.rowCount,portalReturn:true,accessLane:'free'})]);return{restored:true,released:holds.rowCount};}

async function run(options={}){const[planRules,cleanup]=await Promise.all([runPlanRules(options),runCleanup(options)]);return{processed:Number(planRules.processed||0)+Number(cleanup.processed||0),planRules,cleanup};}
function normalize(){return{enabled:false,deprecated:true};}
async function get(){return{enabled:false,deprecated:true,message:'Free-plan inactivity rules are configured on each plan.'};}
async function save(){throw new Error('Free-plan inactivity rules are now configured on each plan.');}
module.exports={KEY,CLEANUP_KEY,HOLD_TYPE,CLEANUP_HOLD_TYPE,DEFAULT_CLEANUP,normalize,get,save,normalizeCleanup,getCleanup,saveCleanup,assessUsage,telemetryReady,candidates,cleanupCandidates,releaseObsoletePlanHolds,runPlanRules,runCleanup,restoreReturningCustomer,run};