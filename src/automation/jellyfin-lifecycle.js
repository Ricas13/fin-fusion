'use strict';

const {query,transaction}=require('../db');
const accessHolds=require('../entitlements/access-holds');
const subscriptionState=require('../entitlements/subscription-state');
const provisioning=require('../jellyfin/provisioning');
const registry=require('../jellyfin/registry');
const planPolicy=require('../entitlements/plan-lifecycle-policy');

const SETTINGS_KEY='jellyfin_lifecycle_v2';
const FREE_HOLD='inactivity_policy';
const DEFAULTS=Object.freeze({
  enabled:false,
  dryRun:true,
  freeNoPlaybackDays:7,
  freeDeleteAfterDisabledDays:7,
  trialDeleteAfterDisabledDays:30,
  paidDeleteAfterDisabledDays:30,
  resellerDeleteAfterDisabledDays:30,
  minimumObservationHours:24
});
function bool(v){return v===true||['1','true','yes','on'].includes(String(v||'').toLowerCase());}
function int(v,min,max,fallback){const n=Number.parseInt(v,10);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function normalize(v={}){return{
  enabled:bool(v.enabled),dryRun:v.dryRun===undefined?true:bool(v.dryRun),
  freeNoPlaybackDays:int(v.freeNoPlaybackDays,1,3650,DEFAULTS.freeNoPlaybackDays),
  freeDeleteAfterDisabledDays:int(v.freeDeleteAfterDisabledDays,1,3650,DEFAULTS.freeDeleteAfterDisabledDays),
  trialDeleteAfterDisabledDays:int(v.trialDeleteAfterDisabledDays,1,3650,DEFAULTS.trialDeleteAfterDisabledDays),
  paidDeleteAfterDisabledDays:int(v.paidDeleteAfterDisabledDays,1,3650,DEFAULTS.paidDeleteAfterDisabledDays),
  resellerDeleteAfterDisabledDays:int(v.resellerDeleteAfterDisabledDays,1,3650,DEFAULTS.resellerDeleteAfterDisabledDays),
  minimumObservationHours:int(v.minimumObservationHours,1,2160,DEFAULTS.minimumObservationHours)
};}
async function getSettings(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[SETTINGS_KEY]);return normalize({...DEFAULTS,...(r.rows[0]?.setting_value||{})});}
async function saveSettings(input,actorUserId=null){const value=normalize(input);await transaction(async client=>{await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[SETTINGS_KEY,JSON.stringify(value),actorUserId]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.jellyfin_lifecycle.update','platform_setting',$2,$3::jsonb)`,[actorUserId,SETTINGS_KEY,JSON.stringify(value)]);});return value;}

async function telemetryReady(){const[worker,servers]=await Promise.all([query(`SELECT EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at)) age_seconds FROM operational_worker_state WHERE worker_key='activity'`),query(`SELECT COUNT(*)::int enabled,COUNT(*) FILTER(WHERE health_status='offline' OR last_health_check IS NULL OR last_health_check<NOW()-INTERVAL '10 minutes')::int unsafe FROM jellyfin_servers WHERE enabled=TRUE`)]);const age=Number(worker.rows[0]?.age_seconds??Infinity),enabled=Number(servers.rows[0]?.enabled||0),unsafe=Number(servers.rows[0]?.unsafe||0);return{ready:Number.isFinite(age)&&age<120&&enabled>0&&unsafe===0,activityWorkerAgeSeconds:Number.isFinite(age)?Math.round(age):null,enabledServers:enabled,unsafeServers:unsafe};}
function delivery(plan){return String(plan?.service_type_snapshot||plan?.service_type||'jellyfin');}
function deletionDays(cause,plan,cfg){const p=planPolicy.normalize(plan?.inactivity_policy||{});if(p.deleteAfterDisabledDays!=null)return p.deleteAfterDisabledDays;if(cause==='free_inactivity')return cfg.freeDeleteAfterDisabledDays;if(cause==='trial_expired')return cfg.trialDeleteAfterDisabledDays;if(cause==='reseller_delinquent')return cfg.resellerDeleteAfterDisabledDays;return cfg.paidDeleteAfterDisabledDays;}

async function freeCandidates(cfg){const r=await query(`
  WITH current_access AS (
    SELECT DISTINCT ON(s.customer_id) s.customer_id,s.id subscription_id,s.plan_id,s.starts_at,s.current_period_end,
      p.code plan_code,p.name plan_name,p.price_minor,p.billing_interval,p.service_type,p.inactivity_policy
    FROM subscriptions s JOIN plans p ON p.id=s.plan_id
    WHERE s.superseded_by IS NULL AND s.status IN('active','trialing','past_due','paused') AND s.starts_at<=NOW() AND s.current_period_end>NOW()
      AND p.price_minor=0 AND p.billing_interval<>'trial' AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
    ORDER BY s.customer_id,s.current_period_end DESC,s.created_at DESC
  )
  SELECT ca.*,ja.id account_id,ja.server_id,ja.jellyfin_user_id,ja.jellyfin_username,ja.created_at account_created_at,ja.disabled,
    ph.last_playback_at,
    EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=ca.customer_id AND aps.server_id=ja.server_id) currently_playing,
    EXISTS(SELECT 1 FROM customer_access_holds h WHERE h.customer_id=ca.customer_id AND h.hold_type=$1 AND h.source_key=('plan:'||ca.plan_id::text) AND h.released_at IS NULL) already_held
  FROM current_access ca JOIN jellyfin_accounts ja ON ja.customer_id=ca.customer_id AND ja.account_purpose='jellyfin' AND ja.is_primary=TRUE
  LEFT JOIN LATERAL(SELECT MAX(COALESCE(ended_at,last_seen_at,started_at)) last_playback_at FROM playback_history WHERE customer_id=ca.customer_id AND server_id=ja.server_id) ph ON TRUE
  WHERE NOT EXISTS(SELECT 1 FROM customer_bans b WHERE b.customer_id=ca.customer_id AND b.revoked_at IS NULL AND b.blocks_service_access=TRUE)
`,[FREE_HOLD]);
  const now=Date.now();return r.rows.map(row=>{const p=planPolicy.normalize(row.inactivity_policy||{}),days=p.noPlaybackDays??cfg.freeNoPlaybackDays,minHours=p.minimumObservationHours??cfg.minimumObservationHours,reference=new Date(row.last_playback_at||row.account_created_at||row.starts_at),ageHours=(now-new Date(row.account_created_at||row.starts_at).getTime())/3600000;const eligible=!row.disabled&&!row.currently_playing&&!row.already_held&&ageHours>=Math.max(minHours,days*24)&&reference.getTime()<=now-days*86400000;return{...row,policy:p,noPlaybackDays:days,referenceAt:reference,eligible};});
}

async function ensureLedger({account,cause,sourceKey,disabledAt,deleteDays,metadata={}}){const due=new Date(new Date(disabledAt).getTime()+deleteDays*86400000);const r=await query(`INSERT INTO jellyfin_account_lifecycle(account_id,customer_id,server_id,jellyfin_user_id,jellyfin_username,cause,source_key,disabled_at,delete_due_at,metadata)
 VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb)
 ON CONFLICT(account_id,cause,source_key) WHERE account_id IS NOT NULL AND recovered_at IS NULL AND deleted_at IS NULL
 DO UPDATE SET delete_due_at=EXCLUDED.delete_due_at,metadata=jellyfin_account_lifecycle.metadata||EXCLUDED.metadata,updated_at=NOW()
 RETURNING *`,[account.id,account.customer_id,account.server_id,account.jellyfin_user_id,account.jellyfin_username,cause,sourceKey,new Date(disabledAt),due,JSON.stringify({...metadata,portalAccountPreserved:true})]);return r.rows[0];}

async function enforceFree(cfg,{actorUserId=null,forceDryRun=null}={}){const rows=await freeCandidates(cfg),eligible=rows.filter(x=>x.eligible);let disabled=0,wouldDisable=0;for(const row of eligible){const dryRun=forceDryRun===null?(row.policy.dryRun||cfg.dryRun):Boolean(forceDryRun),deleteDays=deletionDays('free_inactivity',row,cfg),metadata={planId:row.plan_id,planCode:row.plan_code,noPlaybackDays:row.noPlaybackDays,lastPlaybackAt:row.last_playback_at||null,deleteAfterDisabledDays:deleteDays};await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,dryRun?'jellyfin.lifecycle.would_disable_free':'jellyfin.lifecycle.disable_free',row.customer_id,JSON.stringify({...metadata,portalAccountPreserved:true})]);if(dryRun){wouldDisable++;continue;}await accessHolds.addHold({customerId:row.customer_id,type:FREE_HOLD,sourceKey:`plan:${row.plan_id}`,reason:`No Jellyfin playback for ${row.noPlaybackDays} days`,actorUserId,metadata});await provisioning.reconcileCustomer(row.customer_id);const account=(await query('SELECT * FROM jellyfin_accounts WHERE id=$1',[row.account_id])).rows[0];if(account?.disabled){await ensureLedger({account,cause:'free_inactivity',sourceKey:`plan:${row.plan_id}`,disabledAt:account.updated_at||new Date(),deleteDays,metadata});disabled++;}}
return{processed:rows.length,eligible:eligible.length,disabled,wouldDisable};}

async function classifyDisabled(cfg){const r=await query(`
 SELECT ja.*,c.reseller_id,rs.estate_suspended_at,
   free_hold.source_key free_hold_source,
   sub.id subscription_id,sub.status subscription_status,sub.current_period_end,sub.source subscription_source,
   p.id plan_id,p.code plan_code,p.name plan_name,p.price_minor,p.billing_interval,p.service_type,p.inactivity_policy
 FROM jellyfin_accounts ja JOIN customers c ON c.id=ja.customer_id
 LEFT JOIN resellers rs ON rs.id=c.reseller_id
 LEFT JOIN LATERAL(SELECT source_key FROM customer_access_holds h WHERE h.customer_id=ja.customer_id AND h.hold_type=$1 AND h.released_at IS NULL ORDER BY h.created_at DESC LIMIT 1) free_hold ON TRUE
 LEFT JOIN LATERAL(SELECT s.* FROM subscriptions s WHERE s.customer_id=ja.customer_id ORDER BY s.current_period_end DESC,s.created_at DESC LIMIT 1) sub ON TRUE
 LEFT JOIN plans p ON p.id=sub.plan_id
 WHERE ja.account_purpose='jellyfin' AND ja.disabled=TRUE AND ja.is_primary=TRUE
   AND NOT EXISTS(SELECT 1 FROM jellyfin_account_lifecycle l WHERE l.account_id=ja.id AND l.recovered_at IS NULL AND l.deleted_at IS NULL)
`,[FREE_HOLD]);const out=[];for(const row of r.rows){let cause,sourceKey,disabledAt=row.updated_at||new Date();if(row.reseller_id&&row.estate_suspended_at){cause='reseller_delinquent';sourceKey=`reseller:${row.reseller_id}`;disabledAt=row.estate_suspended_at;}else if(row.free_hold_source){cause='free_inactivity';sourceKey=row.free_hold_source;}else if(row.billing_interval==='trial'){cause='trial_expired';sourceKey=`subscription:${row.subscription_id||'unknown'}`;disabledAt=row.current_period_end||disabledAt;}else if(Number(row.price_minor||0)>0||row.subscription_source){cause='payment_delinquent';sourceKey=`subscription:${row.subscription_id||'unknown'}`;disabledAt=row.current_period_end||disabledAt;}else continue;out.push({...row,cause,sourceKey,disabledAt,deleteDays:deletionDays(cause,row,cfg)});}return out;}

async function recordDisabled(cfg){const rows=await classifyDisabled(cfg);let recorded=0;for(const row of rows){await ensureLedger({account:row,cause:row.cause,sourceKey:row.sourceKey,disabledAt:row.disabledAt,deleteDays:row.deleteDays,metadata:{planId:row.plan_id||null,planCode:row.plan_code||null,subscriptionId:row.subscription_id||null,deleteAfterDisabledDays:row.deleteDays}});recorded++;}return{processed:rows.length,recorded};}

async function markRecoveries(){const r=await query(`UPDATE jellyfin_account_lifecycle l SET recovered_at=NOW(),updated_at=NOW(),metadata=metadata||'{"recovered":true}'::jsonb
 FROM jellyfin_accounts ja WHERE l.account_id=ja.id AND l.recovered_at IS NULL AND l.deleted_at IS NULL AND ja.disabled=FALSE RETURNING l.id`);return r.rowCount;}

async function dueCandidates(){const r=await query(`SELECT l.*,ja.disabled,ja.account_purpose,
 EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=l.customer_id AND aps.server_id=l.server_id) currently_playing
 FROM jellyfin_account_lifecycle l LEFT JOIN jellyfin_accounts ja ON ja.id=l.account_id
 WHERE l.recovered_at IS NULL AND l.deleted_at IS NULL AND l.delete_due_at<=NOW() ORDER BY l.delete_due_at`);return r.rows.map(x=>({...x,eligible:Boolean(x.account_id)&&x.disabled===true&&x.account_purpose==='jellyfin'&&!x.currently_playing}));}
async function deleteDue(cfg,{actorUserId=null,forceDryRun=null}={}){const rows=await dueCandidates(),eligible=rows.filter(x=>x.eligible);let deleted=0,wouldDelete=0,failed=0;for(const row of eligible){const dryRun=forceDryRun===null?cfg.dryRun:Boolean(forceDryRun);await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'jellyfin_account',$3,$4::jsonb)`,[actorUserId,dryRun?'jellyfin.lifecycle.would_delete':'jellyfin.lifecycle.delete',row.account_id,JSON.stringify({cause:row.cause,disabledAt:row.disabled_at,deleteDueAt:row.delete_due_at,portalAccountPreserved:true})]);if(dryRun){wouldDelete++;continue;}try{await registry.request(row.server_id,`/Users/${encodeURIComponent(row.jellyfin_user_id)}`,{method:'DELETE'}).catch(error=>{if(!/404|not found/i.test(String(error.message||error)))throw error;});await transaction(async client=>{await client.query('UPDATE jellyfin_account_lifecycle SET account_id=NULL,deleted_at=NOW(),updated_at=NOW() WHERE id=$1',[row.id]);await client.query('DELETE FROM jellyfin_accounts WHERE id=$1',[row.account_id]);});deleted++;}catch(error){failed++;console.error('Jellyfin lifecycle delete failed:',row.account_id,error.message);}}
return{processed:rows.length,eligible:eligible.length,deleted,wouldDelete,failed};}

async function restoreReturningCustomer(customerId){const holds=await query(`SELECT hold_type,source_key FROM customer_access_holds WHERE customer_id=$1 AND hold_type=$2 AND released_at IS NULL`,[customerId,FREE_HOLD]);if(!holds.rowCount)return{restored:false};const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});if(!entitlement||!['jellyfin','bundle'].includes(delivery(entitlement)))return{restored:false,reason:'no_jellyfin_entitlement'};for(const h of holds.rows)await accessHolds.releaseHold({customerId,type:h.hold_type,sourceKey:h.source_key});await provisioning.reconcileCustomer(customerId);await query(`UPDATE jellyfin_account_lifecycle SET recovered_at=NOW(),updated_at=NOW(),metadata=metadata||'{"portalReturn":true}'::jsonb WHERE customer_id=$1 AND cause='free_inactivity' AND recovered_at IS NULL AND deleted_at IS NULL`,[customerId]);return{restored:true,released:holds.rowCount};}

async function run(options={}){const cfg=await getSettings(),telemetry=await telemetryReady();if(!cfg.enabled)return{processed:0,skipped:'lifecycle_disabled',dryRun:true,telemetry};if(!telemetry.ready)return{processed:0,skipped:'telemetry_not_trustworthy',dryRun:true,telemetry};const free=await enforceFree(cfg,options),recorded=await recordDisabled(cfg),recovered=await markRecoveries(),deletions=await deleteDue(cfg,options);return{processed:Number(free.processed||0)+Number(recorded.processed||0)+Number(deletions.processed||0),free,recorded,recovered,deletions,dryRun:options.forceDryRun===true||cfg.dryRun,telemetry};}
async function preview(){const cfg=await getSettings();return{settings:cfg,telemetry:await telemetryReady(),free:await freeCandidates(cfg),disabled:await classifyDisabled(cfg),due:await dueCandidates()};}

module.exports={SETTINGS_KEY,DEFAULTS,normalize,getSettings,saveSettings,telemetryReady,deletionDays,freeCandidates,enforceFree,classifyDisabled,recordDisabled,markRecoveries,dueCandidates,deleteDue,restoreReturningCustomer,preview,run};
