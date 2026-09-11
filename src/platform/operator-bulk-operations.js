'use strict';

// High-impact customer operations requested by the operator-experience layer.
// They are registered separately from the historical bulk handlers so each can
// preserve its own idempotency and lifecycle safety rules.
const {query}=require('../db');
const bulkWorker=require('../jellyfin/bulk-worker');
const provisioning=require('../jellyfin/provisioning');
const jellyfinAdminControl=require('../jellyfin/admin-control');
const serverMigration=require('../jellyfin/server-migration');
const deletion=require('./customer-deletion');
const manualEntitlement=require('./admin-manual-entitlement');
const subscriptionRevoke=require('./admin-subscription-revoke');
const forceAccess=require('./admin-customer-force-access');

async function actorFor(item){
  const r=await query('SELECT created_by FROM background_jobs WHERE id=$1',[item.job_id]);
  return r.rows[0]?.created_by||null;
}
async function audit(action,customerId,actorUserId,metadata={}){
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,action,customerId,JSON.stringify(metadata)]);
}

bulkWorker.registerHandler('add_plan',async item=>{
  const actor=await actorFor(item),planId=String(item.params?.planId||''),reason=String(item.params?.reason||'Manual bulk plan grant').trim().slice(0,500);
  if(!planId)throw new Error('Plan is required');
  if(reason.length<3)throw new Error('Reason must be at least 3 characters');
  const planResult=await query(`SELECT id,name,duration_days,currency,COALESCE(service_type,'jellyfin') AS service_type FROM plans WHERE id=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND COALESCE(is_addon,FALSE)=FALSE AND audience='direct' AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio') AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) LIMIT 1`,[planId]);
  if(!planResult.rowCount)throw new Error('Target plan is not available for a manual bulk grant');
  const plan=planResult.rows[0],startAt=new Date(),endAt=new Date(startAt);
  endAt.setUTCDate(endAt.getUTCDate()+Math.max(1,Number(plan.duration_days||30)));
  const result=await manualEntitlement.createManualGrant(item.customer_id,actor,{planId:plan.id,method:'other',currency:String(plan.currency||'GBP').toUpperCase(),amountMinor:0,startAt,endAt,externalReference:null,note:reason,returnTab:'access'});
  const payload={planId:plan.id,planName:plan.name,serviceType:plan.service_type,subscriptionId:result.subscriptionId,reconciled:Boolean(result.reconciled),chargedProvider:false,recurringBillingCreated:false,reason,jobItemId:item.id};
  await audit('admin.bulk.add_plan',item.customer_id,actor,payload);
  return payload;
});

bulkWorker.registerHandler('cancel_plan',async item=>{
  const actor=await actorFor(item),reason=String(item.params?.reason||'Plan cancelled by administrator').trim().slice(0,500);
  if(reason.length<3)throw new Error('Reason must be at least 3 characters');
  const rows=await subscriptionRevoke.subscriptions(item.customer_id);
  const primary=rows.find(row=>!row.is_addon);
  if(!primary){
    await audit('admin.bulk.cancel_plan.already_absent',item.customer_id,actor,{reason,jobItemId:item.id});
    return {cancelled:true,alreadyAbsent:true};
  }
  const result=await subscriptionRevoke.revokeSelected(primary,{actorUserId:actor,reason});
  const payload={...result,reason,jobItemId:item.id};
  await audit('admin.bulk.cancel_plan',item.customer_id,actor,payload);
  return payload;
});

bulkWorker.registerHandler('force_server',async item=>{
  const actor=await actorFor(item),targetServerId=String(item.params?.serverId||''),reason=String(item.params?.reason||'Forced Jellyfin server assignment').trim().slice(0,500);
  if(!targetServerId)throw new Error('Target server is required');
  if(reason.length<3)throw new Error('Reason must be at least 3 characters');
  const result=await forceAccess.forceAccess(item.customer_id,targetServerId,{actorUserId:actor});
  const payload={serverId:result.server?.id||targetServerId,serverName:result.server?.name||null,accountId:result.account?.id||null,forceAction:result.action||null,persistentAdminOverride:true,automationProtected:true,reason,jobItemId:item.id};
  await audit('admin.bulk.force_server',item.customer_id,actor,payload);
  return payload;
});

bulkWorker.registerHandler('ban',async item=>{
  const actor=await actorFor(item),reason=String(item.params?.reason||'Administrative ban').slice(0,500);
  const customer=await query(`SELECT c.id,LOWER(BTRIM(COALESCE(c.email,u.email,''))) AS email FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[item.customer_id]);
  if(!customer.rowCount)throw new Error('Customer not found');
  const email=customer.rows[0].email||null;
  const existing=await query(`SELECT id FROM customer_bans WHERE revoked_at IS NULL AND (customer_id=$1 OR ($2::text IS NOT NULL AND normalized_email=$2)) LIMIT 1`,[item.customer_id,email]);
  if(!existing.rowCount){
    await query(`INSERT INTO customer_bans(customer_id,normalized_email,reason,blocks_registration,blocks_service_access,created_by) VALUES($1,$2,$3,TRUE,TRUE,$4)`,[item.customer_id,email,reason,actor]);
  }
  await provisioning.holdAccess(item.customer_id,'banned',actor);
  await audit('admin.bulk.ban',item.customer_id,actor,{email,reason});
  return {banned:true,emailBlocked:Boolean(email),portalAccountPreserved:true};
});

bulkWorker.registerHandler('jellyfin_delete',async item=>{
  const actor=await actorFor(item),reason=String(item.params?.reason||'Jellyfin access deleted by administrator').slice(0,500);
  // The destructive intent is Jellyfin-specific. Persist that authority before
  // touching the remote account so a retry/reconcile cannot recreate Jellyfin,
  // while independently valid Stremio/Emby access remains untouched.
  await jellyfinAdminControl.remove(item.customer_id,null,{actorUserId:actor,reason});
  const result=await deletion.deleteJellyfinAccounts(item.customer_id,{actorUserId:actor,reason,holdAccess:false,removeLocal:true,continueOnMissing:true});
  await audit('admin.bulk.jellyfin_delete',item.customer_id,actor,{...result,portalAccountPreserved:true,service:'jellyfin',serviceControl:'admin_removed'});
  return {...result,portalAccountPreserved:true,serviceHold:false,serviceControl:'admin_removed'};
});

bulkWorker.registerHandler('migrate_server',async item=>{
  const actor=await actorFor(item),targetServerId=String(item.params?.serverId||'');
  if(!targetServerId)throw new Error('Target server is required');
  const previous=await query(`SELECT id,status FROM customer_server_migrations WHERE customer_id=$1 AND target_server_id=$2 ORDER BY requested_at DESC NULLS LAST,created_at DESC NULLS LAST LIMIT 1`,[item.customer_id,targetServerId]).catch(()=>({rows:[]}));
  const existing=previous.rows[0];
  if(existing?.status==='succeeded')return {migrationId:existing.id,status:'succeeded',reused:true};
  let migration;
  if(existing?.status==='pending')migration=existing;
  else migration=await serverMigration.createMigration(item.customer_id,targetServerId,actor);
  const result=await serverMigration.executeMigration(migration.id);
  await audit('admin.bulk.server_migration',item.customer_id,actor,{migrationId:migration.id,targetServerId,status:result?.status||'succeeded'});
  return {migrationId:migration.id,targetServerId,status:result?.status||'succeeded'};
});

module.exports={};