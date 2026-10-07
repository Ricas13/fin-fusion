'use strict';

const {query,transaction}=require('../db');
const billingControl=require('../payments/billing-control');
const subscriptionTermination=require('../payments/subscription-termination');
const planChange=require('../payments/customer-plan-change');
const provisioning=require('../jellyfin/resilient-provisioning');
const stremio=require('../stremio/entitlements');
const managedStremio=require('../stremio/managed-entitlements');

function text(value,max=500){return String(value||'').trim().slice(0,max);}
function serviceType(row){return subscriptionTermination.serviceType(row);}
function recurring(row){return billingControl.isRecurring(row);}
function active(row){return ['active','trialing','past_due','paused'].includes(String(row?.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date());}
function serviceLabel(row){const service=serviceType(row);if(service==='bundle')return'Jellyfin + Stremio';if(service==='stremio')return'Stremio';if(service==='emby')return'Emby';return'Jellyfin';}
function roleLabel(row){return row.is_addon?'Add-on':'Main plan';}

async function subscriptions(customerId){const result=await query(`
  SELECT s.*,p.name plan_name,p.code plan_code,p.is_addon,p.service_type,
         COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') effective_service_type
  FROM subscriptions s
  JOIN plans p ON p.id=s.plan_id
  WHERE s.customer_id=$1 AND s.superseded_by IS NULL
    AND s.status IN ('active','trialing','past_due','paused')
    AND (s.current_period_end IS NULL OR s.current_period_end>NOW())
  ORDER BY COALESCE(p.is_addon,FALSE),s.created_at DESC
`,[customerId]);return result.rows;}
async function ownedSubscription(customerId,subscriptionId){const result=await query(`
  SELECT s.*,p.name plan_name,p.code plan_code,p.is_addon,p.service_type,
         COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') effective_service_type
  FROM subscriptions s JOIN plans p ON p.id=s.plan_id
  WHERE s.id=$1 AND s.customer_id=$2 AND s.superseded_by IS NULL
  LIMIT 1
`,[subscriptionId,customerId]);return result.rows[0]||null;}

async function terminateGenericLocal(row,actorUserId,reason,providerBillingChanged){
  return transaction(async client=>{
    const locked=(await client.query(`SELECT s.id,s.customer_id,s.status,s.current_period_end,s.service_extension_days,s.superseded_by FROM subscriptions s WHERE s.id=$1 AND s.customer_id=$2 FOR UPDATE`,[row.id,row.customer_id])).rows[0];
    if(!locked||locked.superseded_by)throw new Error('This plan is no longer current. Refresh the customer page.');
    if(!active(locked)&&!(locked.status==='cancelled'&&Number(locked.service_extension_days||0)>0))throw new Error('This plan has already ended.');
    const updated=await client.query(`UPDATE subscriptions SET status='cancelled',current_period_end=LEAST(COALESCE(current_period_end,NOW()),NOW()),service_extension_days=0,cancel_at_period_end=TRUE,updated_at=NOW() WHERE id=$1 AND customer_id=$2 RETURNING id,status,current_period_end,cancel_at_period_end,service_extension_days`,[row.id,row.customer_id]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.subscription.revoke_selected','subscription',$2,$3::jsonb)`,[actorUserId,row.id,JSON.stringify({customerId:row.customer_id,planId:row.plan_id,planName:row.plan_name,serviceType:serviceType(row),isAddon:Boolean(row.is_addon),provider:row.source||null,providerBillingChanged:Boolean(providerBillingChanged),reason})]);
    return updated.rows[0];
  });
}

async function cleanupStremio(customerId){
  const remaining=await stremio.entitledSubscription(customerId);
  if(remaining){await stremio.reconcileForCustomer(customerId,remaining);return{revoked:false,preserved:true};}
  await stremio.revoke(customerId);
  const cleanup=await managedStremio.revokeCustomerInactiveMappings(customerId);
  if(Number(cleanup?.failed||0)>0)throw Object.assign(new Error(cleanup.warning||'Some managed Stremio access could not be revoked.'),{code:'STREMIO_REVOKE_INCOMPLETE'});
  return{revoked:true,preserved:false,managedRevoked:Number(cleanup?.revoked||0)};
}

async function revokeSelected(row,{actorUserId=null,reason=''}={}){
  if(!row)throw new Error('Plan not found.');
  if(!active(row))throw new Error('This plan is no longer active. Refresh the customer page.');
  const note=text(reason,500);if(note.length<3)throw new Error('Enter a reason of at least 3 characters.');
  const type=serviceType(row),isJellyfinPrimary=!row.is_addon&&['jellyfin','bundle'].includes(type),providerManaged=recurring(row);
  let pendingPlanChangeCancelled=false,providerResult=null,ended=null;

  if(isJellyfinPrimary){
    const pending=await planChange.pendingForCustomer(row.customer_id);
    if(pending&&String(pending.current_subscription_id)===String(row.id)){await planChange.cancelPendingChange(row.customer_id,null);pendingPlanChangeCancelled=true;}
    ended=providerManaged
      ? await subscriptionTermination.terminateRecurringNow(row,{actorUserId,reason:note,idempotencyKey:`admin-selected-revoke:${row.id}`})
      : await subscriptionTermination.terminateLocal(row.id,row.customer_id,{actorUserId,reason:note,providerBillingChanged:false,reference:`admin-selected-revoke:${row.id}`});
  }else{
    if(providerManaged)providerResult=await billingControl.terminateRecurringForDeletion(row,{idempotencyKey:`admin-selected-revoke:${row.id}`});
    ended=await terminateGenericLocal(row,actorUserId,note,providerManaged);
  }

  let stremioCleanup=null;
  if(['stremio','bundle'].includes(type))stremioCleanup=await cleanupStremio(row.customer_id);
  const outcome=await provisioning.reconcileCustomer(row.customer_id);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.subscription.revoke_selected.completed','subscription',$2,$3::jsonb)`,[actorUserId,row.id,JSON.stringify({customerId:row.customer_id,planId:row.plan_id,planName:row.plan_name,serviceType:type,isAddon:Boolean(row.is_addon),provider:row.source||null,providerBillingChanged:providerManaged,providerStatus:providerResult?.status||ended?.remote?.status||null,pendingPlanChangeCancelled,stremioCleanup,reconciledActive:Boolean(outcome?.active),reason:note})]);
  return{subscriptionId:row.id,planName:row.plan_name,serviceType:type,isAddon:Boolean(row.is_addon),providerBillingChanged:providerManaged,pendingPlanChangeCancelled,stremioCleanup};
}

module.exports={text,serviceType,recurring,active,serviceLabel,roleLabel,subscriptions,ownedSubscription,terminateGenericLocal,cleanupStremio,revokeSelected};
