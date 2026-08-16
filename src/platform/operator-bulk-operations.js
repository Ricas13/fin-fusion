'use strict';

// High-impact customer operations requested by the operator-experience layer.
// They are registered separately from the historical bulk handlers so each can
// preserve its own idempotency and lifecycle safety rules.
const {query}=require('../db');
const bulkWorker=require('../jellyfin/bulk-worker');
const provisioning=require('../jellyfin/provisioning');
const registry=require('../jellyfin/registry');
const serverMigration=require('../jellyfin/server-migration');

async function actorFor(item){
  const r=await query('SELECT created_by FROM background_jobs WHERE id=$1',[item.job_id]);
  return r.rows[0]?.created_by||null;
}
async function audit(action,customerId,actorUserId,metadata={}){
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,action,customerId,JSON.stringify(metadata)]);
}

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
  // An explicit hold prevents the entitlement reconciler from immediately
  // recreating an account while the portal identity remains available.
  await provisioning.holdAccess(item.customer_id,'jellyfin_deleted',actor);
  const accounts=await query(`SELECT id,server_id,jellyfin_user_id,jellyfin_username FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY created_at`,[item.customer_id]);
  let deleted=0;
  for(const account of accounts.rows){
    try{
      await registry.request(account.server_id,`/Users/${encodeURIComponent(account.jellyfin_user_id)}`,{method:'DELETE'});
    }catch(error){
      // A previous attempt may have deleted the remote account before the worker
      // crashed. Treat a remote 404 as already deleted, but surface every other
      // failure rather than erasing the local recovery record.
      const message=String(error?.message||error);
      if(!/\b404\b|not found/i.test(message))throw new Error(`Could not delete ${account.jellyfin_username} from Jellyfin: ${message}`);
    }
    await query('DELETE FROM jellyfin_accounts WHERE id=$1',[account.id]);
    deleted++;
  }
  await audit('admin.bulk.jellyfin_delete',item.customer_id,actor,{deleted,reason,portalAccountPreserved:true});
  return {deleted,portalAccountPreserved:true,serviceHold:true};
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
