'use strict';

// High-impact customer operations requested by the operator-experience layer.
// They are registered separately from the historical bulk handlers so each can
// preserve its own idempotency and lifecycle safety rules.
const {query,transaction}=require('../db');
const bulkOperations=require('./bulk-operations');
const planExpiry=require('../entitlements/plan-expiry');
const bulkWorker=require('../jellyfin/bulk-worker');
const provisioning=require('../jellyfin/resilient-provisioning');
const jellyfinAdminControl=require('../jellyfin/admin-control');
const serverMigration=require('../jellyfin/server-migration');
const deletion=require('./customer-deletion');
const manualEntitlement=require('../entitlements/admin-manual-entitlement-service');
const subscriptionRevoke=require('../entitlements/admin-subscription-revoke-service');
const forceAccess=require('../access/admin-force-access-service');

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
  const planResult=await query(`SELECT id,name,duration_days,currency,COALESCE(service_type,'jellyfin') AS service_type FROM plans WHERE id=$1 AND active=TRUE AND visible=TRUE AND archived_at IS NULL AND COALESCE(is_addon,FALSE)=FALSE AND audience='direct' AND COALESCE(service_type,'jellyfin') IN ('jellyfin','stremio','emby','bundle') AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) LIMIT 1`,[planId]);
  if(!planResult.rowCount)throw new Error('Target plan is not available for a manual bulk grant');
  const plan=planResult.rows[0],operationRef=`bulk:${item.job_id}:${item.id}`;
  // createManualGrant commits the subscription before service reconciliation.
  // Anchor the bulk item in its canonical grant audit so a worker crash after
  // that commit can retry without creating (or falsely failing on) a second plan.
  const prior=await query(`SELECT s.id FROM audit_log a JOIN subscriptions s ON s.id::text=a.entity_id::text WHERE a.action='admin.customer.manual_grant' AND s.customer_id=$1 AND s.plan_id=$2 AND a.metadata->>'externalReference'=$3 ORDER BY a.created_at DESC LIMIT 1`,[item.customer_id,plan.id,operationRef]);
  if(prior.rowCount){
    try{await provisioning.reconcileCustomer(item.customer_id);}
    catch(error){throw new Error(`Plan is already granted, but service reconciliation still failed: ${String(error?.message||error).slice(0,300)}`);}
    return{planId:plan.id,planName:plan.name,serviceType:plan.service_type,subscriptionId:prior.rows[0].id,reconciled:true,chargedProvider:false,recurringBillingCreated:false,reason,jobItemId:item.id,reused:true};
  }
  const startAt=new Date(),endAt=new Date(startAt);
  endAt.setUTCDate(endAt.getUTCDate()+Math.max(1,Number(plan.duration_days||30)));
  const result=await manualEntitlement.createManualGrant(item.customer_id,actor,{planId:plan.id,method:'other',currency:String(plan.currency||'GBP').toUpperCase(),amountMinor:0,startAt,endAt,externalReference:operationRef,note:reason,returnTab:'access'});
  if(!result.reconciled)throw new Error('Plan was granted, but service reconciliation did not complete. Retry this failed bulk item; the existing grant will be reused safely.');
  return{planId:plan.id,planName:plan.name,serviceType:plan.service_type,subscriptionId:result.subscriptionId,reconciled:true,chargedProvider:false,recurringBillingCreated:false,reason,jobItemId:item.id,reused:false};
});

bulkWorker.registerHandler('cancel_plan',async item=>{
  const actor=await actorFor(item),reason=String(item.params?.reason||'Plan cancelled by administrator').trim().slice(0,500);
  if(reason.length<3)throw new Error('Reason must be at least 3 characters');
  const rows=await subscriptionRevoke.subscriptions(item.customer_id);
  const primaries=rows.filter(row=>!row.is_addon);
  if(primaries.length>1){
    const error=new Error('This customer has multiple independent primary services. Bulk cancel refuses to guess which paid plan to terminate; use the customer-specific subscription action instead.');
    error.code='AMBIGUOUS_PRIMARY_SUBSCRIPTION';
    throw error;
  }
  const primary=primaries[0]||null;
  if(!primary){
    // A prior attempt may have committed the cancellation before failing in
    // downstream cleanup/reconciliation. Converge those effects before marking
    // this retry successful; cleanupStremio preserves any still-valid Stremio plan.
    const stremioCleanup=await subscriptionRevoke.cleanupStremio(item.customer_id);
    const outcome=await provisioning.reconcileCustomer(item.customer_id);
    await audit('admin.bulk.cancel_plan.already_absent',item.customer_id,actor,{reason,jobItemId:item.id,stremioCleanup,reconciledActive:Boolean(outcome?.active)});
    return {cancelled:true,alreadyAbsent:true,stremioCleanup,reconciledActive:Boolean(outcome?.active)};
  }
  const result=await subscriptionRevoke.revokeSelected(primary,{actorUserId:actor,reason});
  const payload={...result,reason,jobItemId:item.id};
  await audit('admin.bulk.cancel_plan',item.customer_id,actor,payload);
  return payload;
});

bulkWorker.registerHandler('extend_days',async item=>{
  const actor=await actorFor(item),days=Number(item.params?.days),reason=String(item.params?.reason||'Bulk service extension').trim().slice(0,500);
  if(!Number.isInteger(days)||days<1||days>365)throw new Error('Days must be a whole number between 1 and 365');
  if(reason.length<3)throw new Error('Reason must be at least 3 characters');
  // Same selection rules as the individual extend action, including the refund/chargeback boundary.
  const sub=await bulkOperations.currentSubscription(item.customer_id);
  const subId=sub?.subscription_id||sub?.id;
  if(!subId)throw new Error('Customer has no live plan to extend');
  if(planExpiry.isFreeTier(sub))throw new Error('Free Access has no expiry to extend');
  const reference=`bulk:${item.job_id}:${item.id}`;
  // One transaction: lock the subscription, record the unique (source, reference_id) event, check the
  // cap, add the days and write the audit row. A retried item finds its event already there and
  // changes nothing (including at the cap), and a refund/chargeback termination that commits first
  // makes the event insert fail through the database trigger, so nothing is half-applied.
  const added=await transaction(async client=>{
    const current=await client.query('SELECT service_extension_days,refund_terminated_at FROM subscriptions WHERE id=$1 AND customer_id=$2 FOR UPDATE',[subId,item.customer_id]);
    if(!current.rowCount)throw new Error('Subscription is no longer available');
    if(current.rows[0].refund_terminated_at)throw new Error('Subscription was terminated for a refund or chargeback');
    const inserted=await client.query(`INSERT INTO subscription_service_extension_events(subscription_id,customer_id,source,days,reference_id,actor_user_id,metadata) VALUES($1,$2,'admin_bulk',$3,$4,$5,$6::jsonb) ON CONFLICT(source,reference_id) DO NOTHING RETURNING id`,[subId,item.customer_id,days,reference,actor,JSON.stringify({mode:'bulk',reason,jobItemId:item.id})]);
    if(!inserted.rowCount)return 0;
    if(Number(current.rows[0].service_extension_days||0)+days>3650)throw new Error('Extension would exceed the 3,650-day safety limit');
    await client.query('UPDATE subscriptions SET service_extension_days=service_extension_days+$2,updated_at=NOW() WHERE id=$1 AND customer_id=$3',[subId,days,item.customer_id]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.bulk.extend_days','customer',$2,$3::jsonb)`,[actor,item.customer_id,JSON.stringify({subscriptionId:subId,days,reason,jobItemId:item.id})]);
    return days;
  });
  try{await provisioning.reconcileCustomer(item.customer_id);}
  catch(error){throw new Error(`Days were added, but service reconciliation still failed: ${String(error?.message||error).slice(0,300)}`);}
  return{subscriptionId:subId,addedDays:added,alreadyApplied:!added,reason,chargedProvider:false,jobItemId:item.id};
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
  // A hard ban must supersede any earlier admin-present Jellyfin override.
  await jellyfinAdminControl.remove(item.customer_id,null,{actorUserId:actor,reason:`Customer banned: ${reason}`});
  await provisioning.holdAccess(item.customer_id,'banned',actor);
  const banIntentCleanup=await require('../automation/jellyfin-creation-intent-recovery').recoverCustomer(item.customer_id);
  if(Number(banIntentCleanup?.failed||0)>0)throw new Error(banIntentCleanup.warning||'Customer was banned, but in-flight media access cleanup is incomplete.');
  await audit('admin.bulk.ban',item.customer_id,actor,{email,reason,creationIntentCleanup:banIntentCleanup});
  return {banned:true,emailBlocked:Boolean(email),portalAccountPreserved:true};
});

bulkWorker.registerHandler('jellyfin_delete',async item=>{
  const actor=await actorFor(item),reason=String(item.params?.reason||'Jellyfin access deleted by administrator').slice(0,500);
  // The destructive intent is Jellyfin-specific. Persist that authority before
  // touching the remote account so a retry/reconcile cannot recreate Jellyfin,
  // while independently valid Stremio/Emby access remains untouched.
  await jellyfinAdminControl.remove(item.customer_id,null,{actorUserId:actor,reason});
  const result=await deletion.deleteJellyfinAccounts(item.customer_id,{actorUserId:actor,reason,holdAccess:false,removeLocal:true,continueOnMissing:true});
  const intentCleanup=await require('../automation/jellyfin-creation-intent-recovery').recoverCustomer(item.customer_id);
  if(Number(intentCleanup?.failed||0)>0)throw new Error(intentCleanup.warning||'Jellyfin access was removed locally, but in-flight remote media cleanup is incomplete.');
  await audit('admin.bulk.jellyfin_delete',item.customer_id,actor,{...result,portalAccountPreserved:true,service:'jellyfin',serviceControl:'admin_removed',creationIntentCleanup:intentCleanup});
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