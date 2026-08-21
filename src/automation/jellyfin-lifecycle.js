'use strict';

const {query}=require('../db');
const policy=require('../entitlements/jellyfin-lifecycle-policy');
const provisioning=require('../jellyfin/provisioning');
const registry=require('../jellyfin/registry');

async function telemetryReady(){
  const [worker,servers]=await Promise.all([
    query(`SELECT EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at)) age_seconds FROM operational_worker_state WHERE worker_key='activity'`),
    query(`SELECT COUNT(*)::int enabled,COUNT(*) FILTER(WHERE health_status='offline' OR last_health_check IS NULL OR last_health_check<NOW()-INTERVAL '10 minutes')::int unsafe FROM jellyfin_servers WHERE enabled=TRUE`)
  ]);
  const age=Number(worker.rows[0]?.age_seconds??Infinity),enabled=Number(servers.rows[0]?.enabled||0),unsafe=Number(servers.rows[0]?.unsafe||0);
  return{ready:Number.isFinite(age)&&age<120&&enabled>0&&unsafe===0,activityWorkerAgeSeconds:Number.isFinite(age)?Math.round(age):null,enabledServers:enabled,unsafeServers:unsafe};
}

async function accounts(){
  const r=await query(`
    SELECT ja.*,ja.id account_id,js.name server_name,js.server_class,
      ph.last_playback_at,
      EXISTS(SELECT 1 FROM active_playback_sessions aps WHERE aps.customer_id=ja.customer_id AND aps.server_id=ja.server_id) currently_playing,
      sub.subscription_id,sub.plan_id,sub.status subscription_status,sub.starts_at,sub.current_period_end,sub.source,
      sub.price_minor,sub.billing_interval,sub.service_type,sub.inactivity_policy,
      EXISTS(
        SELECT 1 FROM subscriptions sx JOIN plans px ON px.id=sx.plan_id
        WHERE sx.customer_id=ja.customer_id AND sx.superseded_by IS NULL AND sx.starts_at<=NOW()
          AND sx.current_period_end+(COALESCE(sx.service_extension_days,0)||' days')::interval>NOW()
          AND sx.status IN('active','trialing','paused')
          AND COALESCE(px.service_type,'jellyfin') IN('jellyfin','bundle')
          AND (js.server_class='custom' OR px.server_class=js.server_class)
      ) has_live_jellyfin_entitlement,
      lc.id lifecycle_id,lc.category lifecycle_category,lc.reason lifecycle_reason,lc.disabled_at lifecycle_disabled_at,
      lc.delete_after lifecycle_delete_after,lc.deleted_at lifecycle_deleted_at,lc.restored_at lifecycle_restored_at
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    JOIN customers c ON c.id=ja.customer_id
    LEFT JOIN LATERAL (
      SELECT MAX(COALESCE(ended_at,last_seen_at,started_at)) last_playback_at
      FROM playback_history WHERE customer_id=ja.customer_id AND server_id=ja.server_id
    ) ph ON TRUE
    LEFT JOIN LATERAL (
      SELECT s.id subscription_id,s.plan_id,s.status,s.starts_at,s.current_period_end,s.source,
             p.price_minor,p.billing_interval,COALESCE(p.service_type,'jellyfin') service_type,p.inactivity_policy
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.customer_id=ja.customer_id AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND (js.server_class='custom' OR p.server_class=js.server_class)
      ORDER BY s.current_period_end DESC,s.created_at DESC LIMIT 1
    ) sub ON TRUE
    LEFT JOIN jellyfin_account_lifecycle lc ON lc.account_id=ja.id AND lc.deleted_at IS NULL AND lc.restored_at IS NULL
    WHERE ja.account_purpose='jellyfin'
    ORDER BY ja.customer_id,js.priority,ja.created_at
  `);
  return r.rows;
}

function classify(row,cfg){
  if(!row.subscription_id)return{shouldDisable:false,reason:'no_subscription_history'};
  const category=policy.categoryFor({serverClass:row.server_class,billingInterval:row.billing_interval,priceMinor:row.price_minor,source:row.source});
  const plan={inactivity_policy:row.inactivity_policy||{}};
  const deletion=policy.deleteDays(cfg,category,plan);
  if(category==='free'&&row.has_live_jellyfin_entitlement){
    const inactivity=policy.freeNoPlaybackDays(cfg,plan),reference=row.last_playback_at||row.last_activity_at||row.created_at;
    const oldEnough=reference&&new Date(reference).getTime()<=Date.now()-inactivity.days*86400000;
    if(oldEnough)return{shouldDisable:true,category,deleteDays:deletion.days,policySource:deletion.source==='plan'||inactivity.source==='plan'?'plan':'global',reason:`no_playback_${inactivity.days}_days`,reference};
    return{shouldDisable:false,category,reason:'free_usage_active'};
  }
  if(!row.has_live_jellyfin_entitlement&&['trial','paid'].includes(category)){
    return{shouldDisable:true,category,deleteDays:deletion.days,policySource:deletion.source,reason:category==='trial'?'trial_expired':'paid_entitlement_lapsed'};
  }
  return{shouldDisable:false,category,reason:'entitled'};
}

async function audit(action,row,metadata){return query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES($1,'jellyfin_account',$2,$3::jsonb)`,[action,row.account_id,JSON.stringify({...metadata,portalAccountPreserved:true})]);}

async function scheduleDisable(row,decision,cfg){
  const now=new Date(),deleteAfter=new Date(now.getTime()+decision.deleteDays*86400000),evidence={category:decision.category,reason:decision.reason,deleteAfterDisableDays:decision.deleteDays,policySource:decision.policySource,serverId:row.server_id,customerId:row.customer_id,dryRun:cfg.dryRun};
  await audit(cfg.dryRun?'jellyfin.lifecycle.would_disable':'jellyfin.lifecycle.disable',row,evidence);
  if(cfg.dryRun)return{changed:false,dryRun:true};
  if(!row.disabled)await provisioning.disableJellyfinAccount(row);
  await query(`INSERT INTO jellyfin_account_lifecycle(account_id,customer_id,server_id,jellyfin_user_id,jellyfin_username,category,reason,policy_source,disabled_at,delete_after,metadata)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
    ON CONFLICT(account_id) DO UPDATE SET category=EXCLUDED.category,reason=EXCLUDED.reason,policy_source=EXCLUDED.policy_source,
      disabled_at=COALESCE(jellyfin_account_lifecycle.disabled_at,EXCLUDED.disabled_at),delete_after=EXCLUDED.delete_after,
      deleted_at=NULL,restored_at=NULL,metadata=EXCLUDED.metadata,updated_at=NOW()`,
    [row.account_id,row.customer_id,row.server_id,row.jellyfin_user_id,row.jellyfin_username,decision.category,decision.reason,decision.policySource,now,deleteAfter,JSON.stringify(evidence)]);
  return{changed:true,deleteAfter};
}

async function restore(row,decision,cfg){
  if(!row.lifecycle_id)return{changed:false};
  await audit(cfg.dryRun?'jellyfin.lifecycle.would_restore':'jellyfin.lifecycle.restore',row,{priorReason:row.lifecycle_reason,decision:decision.reason,dryRun:cfg.dryRun});
  if(cfg.dryRun)return{changed:false,dryRun:true};
  await provisioning.reconcileCustomer(row.customer_id);
  await query(`UPDATE jellyfin_account_lifecycle SET restored_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.lifecycle_id]);
  return{changed:true};
}

async function deleteDue(row,decision,cfg){
  if(!row.lifecycle_id||!row.lifecycle_delete_after||new Date(row.lifecycle_delete_after)>new Date())return{deleted:false};
  if(row.currently_playing||!decision.shouldDisable)return{deleted:false};
  await audit(cfg.dryRun?'jellyfin.lifecycle.would_delete':'jellyfin.lifecycle.delete',row,{category:decision.category,reason:decision.reason,disabledAt:row.lifecycle_disabled_at,deleteAfter:row.lifecycle_delete_after,dryRun:cfg.dryRun});
  if(cfg.dryRun)return{deleted:false,dryRun:true};
  try{await registry.request(row.server_id,`/Users/${encodeURIComponent(row.jellyfin_user_id)}`,{method:'DELETE'});}catch(error){const message=String(error?.message||error);if(!/\b404\b|not found/i.test(message))throw error;}
  await query(`UPDATE jellyfin_account_lifecycle SET account_id=NULL,deleted_at=NOW(),updated_at=NOW() WHERE id=$1`,[row.lifecycle_id]);
  await query('DELETE FROM jellyfin_accounts WHERE id=$1',[row.account_id]);
  return{deleted:true};
}

async function restoreDeletedForEntitledCustomers(){
  const rows=await query(`SELECT DISTINCT lc.customer_id FROM jellyfin_account_lifecycle lc
    JOIN customers c ON c.id=lc.customer_id
    WHERE lc.deleted_at IS NOT NULL AND lc.restored_at IS NULL
      AND EXISTS(SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=lc.customer_id AND s.superseded_by IS NULL
        AND s.starts_at<=NOW() AND s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval>NOW()
        AND s.status IN('active','trialing','paused') AND COALESCE(p.service_type,'jellyfin') IN('jellyfin','bundle')
        AND (lc.category<>'free' OR s.created_at>lc.deleted_at))`);
  let restored=0;
  for(const row of rows.rows){
    try{
      await provisioning.reconcileCustomer(row.customer_id);
      await query(`UPDATE jellyfin_account_lifecycle SET restored_at=NOW(),updated_at=NOW() WHERE customer_id=$1 AND deleted_at IS NOT NULL AND restored_at IS NULL`,[row.customer_id]);
      restored++;
    }catch(error){console.error('Jellyfin lifecycle reprovision failed:',{customerId:row.customer_id,error:String(error?.message||error).slice(0,500)});}
  }
  return restored;
}

async function run(){
  const cfg=await policy.get();if(!cfg.enabled)return{processed:0,disabled:0,deleted:0,restored:0,skipped:'lifecycle_disabled'};
  const telemetry=await telemetryReady();if(!telemetry.ready)return{processed:0,disabled:0,deleted:0,restored:0,skipped:'telemetry_not_trustworthy',telemetry};
  const rows=await accounts();let disabled=0,deleted=0,restored=0,failed=0;
  for(const row of rows){
    try{
      const decision=classify(row,cfg);
      if(row.lifecycle_id){
        const out=await deleteDue(row,decision,cfg);if(out.deleted){deleted++;continue;}
        if(!decision.shouldDisable&&row.has_live_jellyfin_entitlement){const r=await restore(row,decision,cfg);if(r.changed)restored++;}
      }else if(decision.shouldDisable&&!row.currently_playing){const d=await scheduleDisable(row,decision,cfg);if(d.changed)disabled++;}
    }catch(error){failed++;console.error('Jellyfin lifecycle account processing failed:',{accountId:row.account_id,error:String(error?.message||error).slice(0,500)});}
  }
  restored+=await restoreDeletedForEntitledCustomers();
  return{processed:rows.length,disabled,deleted,restored,failed,dryRun:cfg.dryRun,telemetry};
}

module.exports={telemetryReady,accounts,classify,run};
