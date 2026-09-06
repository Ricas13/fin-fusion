'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');
const billingControl=require('../payments/billing-control');
const subscriptionTermination=require('../payments/subscription-termination');
const planChange=require('../payments/customer-plan-change');
const provisioning=require('../jellyfin/resilient-provisioning');
const stremio=require('../stremio/entitlements');
const managedStremio=require('../stremio/managed-entitlements');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function text(value,max=500){return String(value||'').trim().slice(0,max);}
function serviceType(row){return subscriptionTermination.serviceType(row);}
function recurring(row){return billingControl.isRecurring(row);}
function active(row){return ['active','trialing','past_due','paused'].includes(String(row?.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date());}
function dt(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function backPath(customerId,key='',message=''){const notice=key?`&${encodeURIComponent(key)}=${encodeURIComponent(message)}`:'';return `/admin/users/${encodeURIComponent(customerId)}?tab=access${notice}`;}
function serviceLabel(row){const service=serviceType(row);if(service==='bundle')return'Jellyfin + Stremio';if(service==='stremio')return'Stremio';if(service==='emby')return'Emby';return'Jellyfin';}
function roleLabel(row){return row.is_addon?'Add-on':'Main plan';}

async function customer(customerId){const result=await query(`SELECT c.id,COALESCE(c.display_name,u.username,c.email,'Customer') name,COALESCE(c.email,u.email) email FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[customerId]);return result.rows[0]||null;}
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
  const cleanup=await managedStremio.revokeInactiveMappings();
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

function subscriptionCard(row,token,customerId){
  const recurringCopy=recurring(row)?`Recurring ${String(row.source||'provider')} billing will be cancelled and verified before local access is removed.`:'Only this local/prepaid entitlement is ended.';
  const stremioCopy=['stremio','bundle'].includes(serviceType(row))?' If this is the customer’s last Stremio entitlement, its installation credential and managed Stremio access are revoked too.':'';
  return `<section class="serverCard"><div class="sectionHead"><div><h3>${esc(row.plan_name||row.plan_code||'Plan')}</h3><div class="muted">${esc(roleLabel(row))} · ${esc(serviceLabel(row))} · ${esc(row.source||'local')} · ends ${esc(dt(row.current_period_end))}</div></div><span class="pill ${row.is_addon?'warn':'good'}">${esc(roleLabel(row))}</span></div><div class="inlineHelp">${esc(recurringCopy+stremioCopy)}</div><details class="opInlineDetails"><summary>Revoke this plan…</summary><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(customerId)}/subscriptions/${encodeURIComponent(row.id)}/revoke" data-native-submit="true"><input type="hidden" name="_csrf" value="${esc(token)}"><div class="formGroup"><label>Administrator reason</label><input class="input" name="reason" minlength="3" maxlength="500" required placeholder="Why is this specific plan being revoked?"></div><div class="notice error"><strong>Only ${esc(row.plan_name||'this plan')} will be revoked.</strong> Other active plans/add-ons remain in place unless they depend on this bundle.</div><div class="formGroup"><label>Type REVOKE to confirm</label><input class="input" name="confirmWord" autocomplete="off" required></div><button class="button btn-danger" type="submit">Revoke ${esc(row.plan_name||'selected plan')}</button></form></details></section>`;
}

async function page(req,res,next){
  try{
    await runtimeSettings.ensureLoaded();
    const c=await customer(req.params.customerId);if(!c)return res.status(404).send('Customer not found');
    const rows=await subscriptions(c.id),token=csrf.token(req);
    const body=`<section class="section"><div class="sectionHead"><div><h2>Revoke a specific plan</h2><div class="muted">${esc(c.name)} · choose exactly which entitlement to end. Other plans are preserved.</div></div><a class="button secondary" href="${esc(backPath(c.id))}">Back to customer</a></div><div class="notice"><strong>Plan-specific control.</strong> This page never guesses the customer’s “main” plan. Each action is bound to the subscription shown below.</div>${rows.length?`<div class="serverGrid">${rows.map(row=>subscriptionCard(row,token,c.id)).join('')}</div>`:'<div class="emptyCompact">No currently active plans or add-ons are available to revoke.</div>'}</section>`;
    return res.send(layout({siteName:runtimeSettings.siteName(),active:'users',title:'Revoke a plan',subtitle:c.name,body}));
  }catch(error){return next(error);}
}

function createAdminSubscriptionRevokeRouter(){
  const r=express.Router();r.use('/admin/users',gate,noStore);
  r.get('/admin/users/:customerId/subscriptions/revoke',page);
  r.post('/admin/users/:customerId/subscriptions/:subscriptionId/revoke',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId;
    try{
      if(String(req.body.confirmWord||'').trim()!=='REVOKE')throw new Error('Type REVOKE exactly to confirm.');
      const row=await ownedSubscription(customerId,req.params.subscriptionId);if(!row)throw new Error('That plan does not belong to this customer.');
      const result=await revokeSelected(row,{actorUserId:req.session.authUserId,reason:req.body.reason});
      return res.redirect(backPath(customerId,'message',`${result.planName} was revoked. Other plans were preserved.`));
    }catch(error){
      console.error('Targeted subscription revoke failed:',{customerId,subscriptionId:req.params.subscriptionId,error:error.message});
      return res.redirect(backPath(customerId,'error',`Plan could not be revoked: ${text(error.message||error,400)}`));
    }
  });
  return r;
}

module.exports={createAdminSubscriptionRevokeRouter,subscriptions,ownedSubscription,revokeSelected,cleanupStremio,serviceLabel,roleLabel};
