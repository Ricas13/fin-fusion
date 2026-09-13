'use strict';

const crypto=require('crypto');
const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');
const subscriptionState=require('../entitlements/subscription-state');
const planExpiry=require('../entitlements/plan-expiry');
const accessHolds=require('../entitlements/access-holds');
const serviceAdminControl=require('../entitlements/service-admin-control');
const provisioning=require('../jellyfin/resilient-provisioning');
const provisioningHelpers=require('../jellyfin/provisioning-helpers');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIRECT_ACTIONS=new Set(['extend','expiry','suspend','delete-jellyfin']);
const LEGACY_BULK_BRIDGE=new Map([
  ['extend_entitlement','extend'],
  ['set_expiry','expiry'],
  ['suspend','suspend'],
  ['jellyfin_delete','delete-jellyfin']
]);
const writeLimit=routeRateLimit.middleware({scope:'admin-customer-individual-action',max:30,windowSeconds:60,reason:'admin_customer_individual_action'});

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function customerPath(customerId,key='',message=''){const notice=key?`&${encodeURIComponent(key)}=${encodeURIComponent(message)}`:'';return `/admin/users/${encodeURIComponent(customerId)}?tab=access${notice}`;}
function actionPath(customerId,action){return `/admin/users/${encodeURIComponent(customerId)}/actions/${encodeURIComponent(action)}`;}
function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function dateOnly(value){if(!value)return'';const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);}
function exactConfirmation(req,value){return String(req.body?.confirmWord||'').trim().toUpperCase()===value;}
function operationId(value){const id=String(value||'').trim();if(!UUID.test(id))throw new Error('This action form has expired. Open it again and retry.');return id;}
function subscriptionId(value){const id=String(value||'').trim();if(!UUID.test(id))throw new Error('Choose the subscription this action should change.');return id;}

async function audit(actorUserId,action,customerId,metadata={}){
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,$2,'customer',$3,$4::jsonb)`,[actorUserId,action,customerId,JSON.stringify(metadata)]);
}

async function customer(customerId){
  const result=await query(`SELECT c.id,COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS name,COALESCE(c.email,u.email) AS email FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[customerId]);
  return result.rows[0]||null;
}

async function currentSubscription(customerId){
  const latestResult=await query(`
    SELECT s.*,p.is_free_tier,p.duration_days,p.billing_interval,
      EXISTS(
        SELECT 1 FROM audit_log terminal_audit
        WHERE terminal_audit.entity_type='subscription'
          AND terminal_audit.entity_id=s.id::text
          AND terminal_audit.action='billing.subscription.terminate_for_refund'
      ) AS refund_terminated
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.customer_id=$1
      AND COALESCE(p.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND s.superseded_by IS NULL
    ORDER BY s.created_at DESC
    LIMIT 1
  `,[customerId]);
  const latest=latestResult.rows[0]||null;
  if(latest?.refund_terminated)return null;
  const effective=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true});
  return effective||latest;
}

async function subscriptionForCustomer(customerId,value){
  const id=subscriptionId(value);
  const result=await query(`
    SELECT s.*,p.is_free_tier,p.duration_days,p.billing_interval,
      EXISTS(
        SELECT 1 FROM audit_log terminal_audit
        WHERE terminal_audit.entity_type='subscription'
          AND terminal_audit.entity_id=s.id::text
          AND terminal_audit.action='billing.subscription.terminate_for_refund'
      ) AS refund_terminated
    FROM subscriptions s
    JOIN plans p ON p.id=s.plan_id
    WHERE s.id=$1
      AND s.customer_id=$2
      AND COALESCE(p.is_addon,FALSE)=FALSE
      AND COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
      AND s.superseded_by IS NULL
    LIMIT 1
  `,[id,customerId]);
  const sub=result.rows[0]||null;
  if(!sub||sub.refund_terminated)throw new Error('That subscription is not available for this customer.');
  return sub;
}

async function jellyfinAccounts(customerId){
  const result=await query(`
    SELECT ja.*,js.name AS server_name
    FROM jellyfin_accounts ja
    JOIN jellyfin_servers js ON js.id=ja.server_id
    WHERE ja.customer_id=$1
      AND COALESCE(ja.account_purpose,'jellyfin')='jellyfin'
      AND COALESCE(js.media_server_type,'jellyfin')='jellyfin'
    ORDER BY ja.created_at,ja.id
  `,[customerId]);
  return result.rows;
}

function pageShell(req,c,title,description,content){
  const back=customerPath(c.id);
  const body=`<section class="section"><div class="sectionHead"><div><h2>${esc(title)}</h2><div class="muted">${esc(c.name)} · ${esc(description)}</div></div><a class="button secondary" href="${esc(back)}">Back to customer</a></div>${content}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'users',title,subtitle:c.name,body});
}

async function extendPage(req,c){
  const sub=await subscriptionForCustomer(c.id,req.query?.subscriptionId);
  if(planExpiry.isFreeTier(sub))return pageShell(req,c,'Extend plan','Individual customer action','<div class="notice error">Free Access has no expiry to extend.</div>');
  const durationDays=Math.max(1,Number(sub.duration_days_snapshot||sub.duration_days||30));
  const existing=Math.max(0,Number(sub.service_extension_days||0));
  const remainingAllowance=Math.max(0,3650-existing);
  if(remainingAllowance<durationDays)return pageShell(req,c,'Extend plan','Individual customer action','<div class="notice error">This subscription has reached the 3,650-day manual extension safety limit.</div>');
  const maxUnits=Math.floor(remainingAllowance/durationDays),subId=sub.id||sub.subscription_id;
  const form=`<div class="notice"><strong>Individual action.</strong> This adds service time to the selected subscription only. It does not create a new provider charge.</div><form class="formPanel" method="post" action="${esc(actionPath(c.id,'extend'))}" data-native-submit="true">${csrfHidden(csrf.token(req))}<input type="hidden" name="subscriptionId" value="${esc(subId)}"><input type="hidden" name="operationId" value="${esc(crypto.randomUUID())}"><div class="formGroup"><label>Plan periods to add</label><input class="input" type="number" name="units" min="1" max="${esc(maxUnits)}" value="1" required><div class="inlineHelp">Subscription ${esc(subId)} · one period is ${esc(durationDays)} day${durationDays===1?'':'s'}. Existing manual extension: ${esc(existing)} day${existing===1?'':'s'}. Maximum combined manual extension: 3,650 days.</div></div><div class="formGroup"><label>Type EXTEND to confirm</label><input class="input" name="confirmWord" autocomplete="off" required></div><button class="button" type="submit">Extend this subscription</button></form>`;
  return pageShell(req,c,'Extend plan','Individual customer action',form);
}

async function expiryPage(req,c){
  const sub=await subscriptionForCustomer(c.id,req.query?.subscriptionId);
  if(planExpiry.isFreeTier(sub))return pageShell(req,c,'Edit expiry','Individual customer action','<div class="notice error">Free Access does not use an expiry date.</div>');
  if(subscriptionState.recurringProvider(sub))return pageShell(req,c,'Edit expiry','Provider-controlled recurring plan','<div class="notice error"><strong>This expiry is controlled by the payment provider.</strong> Fin-Fusion will not rewrite the local end date for an active Stripe/PayPal recurring agreement because that would make billing and access disagree. Use renewal/cancellation or the plan-change workflow instead.</div>');
  const current=dateOnly(sub.current_period_end)||new Date().toISOString().slice(0,10),subId=sub.id||sub.subscription_id;
  const form=`<div class="notice"><strong>Individual action.</strong> This changes the selected subscription only and clears its previously-added service-extension days.</div><form class="formPanel" method="post" action="${esc(actionPath(c.id,'expiry'))}" data-native-submit="true">${csrfHidden(csrf.token(req))}<input type="hidden" name="subscriptionId" value="${esc(subId)}"><div class="formGroup"><label>New expiry date</label><input class="input" type="date" name="expiryDate" value="${esc(current)}" required><div class="inlineHelp">Subscription ${esc(subId)}</div></div><div class="formGroup"><label>Type EXPIRY to confirm</label><input class="input" name="confirmWord" autocomplete="off" required></div><button class="button" type="submit">Set expiry for this subscription</button></form>`;
  return pageShell(req,c,'Edit expiry','Individual customer action',form);
}

function suspendPage(req,c){
  const form=`<div class="notice error"><strong>Suspend this customer only.</strong> Access is held until an administrator releases the suspension. Billing/subscription records are not deleted.</div><form class="formPanel" method="post" action="${esc(actionPath(c.id,'suspend'))}" data-native-submit="true">${csrfHidden(csrf.token(req))}<div class="formGroup"><label>Administrator reason</label><input class="input" name="reason" minlength="3" maxlength="500" required placeholder="Why is this customer being suspended?"></div><div class="formGroup"><label>Type SUSPEND to confirm</label><input class="input" name="confirmWord" autocomplete="off" required></div><button class="button btn-danger" type="submit">Suspend this customer</button></form>`;
  return pageShell(req,c,'Add suspension','Individual customer action',form);
}

async function deleteJellyfinPage(req,c){
  const accounts=await jellyfinAccounts(c.id);
  const rows=accounts.length?`<div class="tableWrap"><table class="table"><thead><tr><th>Jellyfin user</th><th>Server</th></tr></thead><tbody>${accounts.map(row=>`<tr><td>${esc(row.jellyfin_username||row.jellyfin_user_id||row.id)}</td><td>${esc(row.server_name||row.server_id)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="notice">There are no ordinary Jellyfin customer accounts to delete. Emby and internal Stremio identities are intentionally excluded.</div>';
  const form=accounts.length?`<div class="notice error"><strong>Destructive individual action.</strong> Only the Jellyfin account(s) listed above are removed. The portal customer, plan/payment history, Emby accounts and internal Stremio identities are preserved. Jellyfin is left explicitly Removed for this customer so automation cannot immediately recreate the account; use Return to Automatic when access should be allowed again.</div><form class="formPanel" method="post" action="${esc(actionPath(c.id,'delete-jellyfin'))}" data-native-submit="true">${csrfHidden(csrf.token(req))}<div class="formGroup"><label>Administrator reason</label><input class="input" name="reason" minlength="3" maxlength="500" required placeholder="Why are these Jellyfin accounts being deleted?"></div><div class="formGroup"><label>Type DELETE JELLYFIN to confirm</label><input class="input" name="confirmWord" autocomplete="off" required></div><button class="button btn-danger" type="submit">Delete this customer's Jellyfin account(s)</button></form>`:'';
  return pageShell(req,c,'Delete Jellyfin account(s)','Individual customer action',`${rows}${form}`);
}

async function renderAction(req,res,next){
  try{
    const customerId=String(req.params.customerId||'');
    const action=String(req.params.action||'');
    if(!UUID.test(customerId)||!DIRECT_ACTIONS.has(action))return res.status(404).send('Action not found');
    const c=await customer(customerId);if(!c)return res.status(404).send('Customer not found');
    await runtimeSettings.ensureLoaded();
    if(action==='extend')return res.send(await extendPage(req,c));
    if(action==='expiry')return res.send(await expiryPage(req,c));
    if(action==='suspend')return res.send(suspendPage(req,c));
    return res.send(await deleteJellyfinPage(req,c));
  }catch(error){return next(error);}
}

async function performExtend(req){
  if(!exactConfirmation(req,'EXTEND'))throw new Error('Type EXTEND exactly to confirm.');
  const op=operationId(req.body?.operationId);
  const units=Number(req.body?.units);
  if(!Number.isInteger(units)||units<1)throw new Error('Choose at least one plan period to add.');
  const sub=await subscriptionForCustomer(req.params.customerId,req.body?.subscriptionId);
  if(planExpiry.isFreeTier(sub))throw new Error('Free Access has no expiry to extend.');
  const subId=sub.id||sub.subscription_id;
  const durationDays=Math.max(1,Number(sub.duration_days_snapshot||sub.duration_days||30));
  const requestedDays=durationDays*units,currentDays=Math.max(0,Number(sub.service_extension_days||0));
  if(!Number.isInteger(requestedDays)||requestedDays<1||currentDays+requestedDays>3650)throw new Error('Requested service extension exceeds the 3,650-day safety limit.');
  let remaining=requestedDays,chunk=0,added=0;
  while(remaining>0){
    const days=Math.min(365,remaining),reference=`admin-single:${op}:${chunk}`;
    const didAdd=await transaction(async client=>{
      const inserted=await client.query(`INSERT INTO subscription_service_extension_events(subscription_id,customer_id,source,days,reference_id,metadata) VALUES($1,$2,'admin_bulk',$3,$4,$5::jsonb) ON CONFLICT(source,reference_id) DO NOTHING RETURNING id`,[subId,req.params.customerId,days,reference,JSON.stringify({mode:'single_customer',actorUserId:req.session.authUserId,subscriptionId:subId,units,chunk})]);
      if(!inserted.rowCount)return false;
      const updated=await client.query(`UPDATE subscriptions SET service_extension_days=service_extension_days+$2,updated_at=NOW() WHERE id=$1 AND customer_id=$3 RETURNING id`,[subId,days,req.params.customerId]);
      if(!updated.rowCount)throw new Error('The selected subscription changed before the extension could be saved.');
      return true;
    });
    if(didAdd)added+=days;
    remaining-=days;chunk+=1;
  }
  await provisioning.reconcileCustomer(req.params.customerId);
  await audit(req.session.authUserId,'admin.customer.extend_entitlement',req.params.customerId,{subscriptionId:subId,units,requestedDays,addedDays:added,operationId:op});
  if(!added)return 'This extension had already been applied. No additional days were added.';
  return `${added} day${added===1?'':'s'} added to the selected subscription.`;
}

async function performExpiry(req){
  if(!exactConfirmation(req,'EXPIRY'))throw new Error('Type EXPIRY exactly to confirm.');
  const expiryDate=String(req.body?.expiryDate||'');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(expiryDate))throw new Error('Choose a valid expiry date.');
  const sub=await subscriptionForCustomer(req.params.customerId,req.body?.subscriptionId);
  if(planExpiry.isFreeTier(sub))throw new Error('Free Access does not use an expiry date.');
  if(subscriptionState.recurringProvider(sub))throw new Error('Expiry on an active Stripe/PayPal recurring agreement is provider-controlled. Use billing cancellation or plan change instead.');
  const subId=sub.id||sub.subscription_id;
  const updated=await query(`UPDATE subscriptions SET current_period_end=$2::date,service_extension_days=0,updated_at=NOW() WHERE id=$1 AND customer_id=$3 RETURNING id`,[subId,expiryDate,req.params.customerId]);
  if(!updated.rowCount)throw new Error('The selected subscription changed before the expiry could be saved.');
  await provisioning.reconcileCustomer(req.params.customerId);
  await audit(req.session.authUserId,'admin.customer.set_expiry',req.params.customerId,{subscriptionId:subId,expiryDate,clearedServiceExtensions:true});
  return `Expiry set to ${expiryDate} for the selected subscription.`;
}

async function performSuspend(req){
  if(!exactConfirmation(req,'SUSPEND'))throw new Error('Type SUSPEND exactly to confirm.');
  const reason=clean(req.body?.reason,500);if(reason.length<3)throw new Error('Enter a suspension reason of at least 3 characters.');
  await accessHolds.addHold({customerId:req.params.customerId,type:'admin_suspended',sourceKey:'admin',reason,actorUserId:req.session.authUserId,metadata:{origin:'customer_360'}});
  let reconcileError='',outcome=null;
  try{outcome=await provisioning.reconcileCustomer(req.params.customerId);}catch(error){reconcileError=clean(error.message||error,400);}
  await audit(req.session.authUserId,'admin.customer.suspend',req.params.customerId,{reason,active:Boolean(outcome?.active),reconcileError:reconcileError||null});
  return reconcileError?`Customer suspended. The hold is active, but reconciliation needs attention: ${reconcileError}`:'Customer suspended. Access will remain held until the suspension is released.';
}

async function performJellyfinDelete(req){
  if(!exactConfirmation(req,'DELETE JELLYFIN'))throw new Error('Type DELETE JELLYFIN exactly to confirm.');
  const reason=clean(req.body?.reason,500);if(reason.length<3)throw new Error('Enter a deletion reason of at least 3 characters.');
  const accounts=await jellyfinAccounts(req.params.customerId);
  if(!accounts.length)return 'No ordinary Jellyfin customer accounts were present. Nothing was deleted.';
  await audit(req.session.authUserId,'admin.customer.jellyfin.delete_accounts.requested',req.params.customerId,{reason,accounts:accounts.map(row=>({accountId:row.id,serverId:row.server_id,username:row.jellyfin_username||null,accessLane:row.access_lane||null}))});
  await serviceAdminControl.setRemoved(req.params.customerId,'jellyfin',{actorUserId:req.session.authUserId,reason});
  let reconcileError='';
  try{await provisioning.reconcileCustomer(req.params.customerId);}catch(error){reconcileError=clean(error.message||error,500);}
  let remaining=await jellyfinAccounts(req.params.customerId),cleanupFailures=[];
  for(const account of remaining){
    try{await provisioningHelpers.deleteJellyfinAccount(account,{reason,actorUserId:req.session.authUserId});}
    catch(error){cleanupFailures.push({accountId:account.id,username:account.jellyfin_username||null,error:clean(error.message||error,500)});}
  }
  remaining=await jellyfinAccounts(req.params.customerId);
  const removed=Math.max(0,accounts.length-remaining.length);
  await audit(req.session.authUserId,'admin.customer.jellyfin.delete_accounts.completed',req.params.customerId,{reason,requested:accounts.length,removed,remaining:remaining.map(row=>({accountId:row.id,serverId:row.server_id,username:row.jellyfin_username||null,accessLane:row.access_lane||null})),cleanupFailures,reconcileError:reconcileError||null});
  if(remaining.length)throw new Error(`Jellyfin is now pinned to Removed, but ${remaining.length} account${remaining.length===1?' still exists':'s still exist'}. ${cleanupFailures[0]?.error||reconcileError||'Run the deletion action again after checking Jellyfin connectivity.'}`);
  const suffix=reconcileError?` Jellyfin was removed successfully, but another reconciliation step reported: ${reconcileError}`:'';
  return `${removed} Jellyfin account${removed===1?'':'s'} removed. Portal, billing history, Emby and Stremio identities were preserved.${suffix}`;
}

async function performAction(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
  const customerId=String(req.params.customerId||''),action=String(req.params.action||'');
  if(!UUID.test(customerId)||!DIRECT_ACTIONS.has(action))return res.status(404).send('Action not found');
  try{
    const c=await customer(customerId);if(!c)return res.status(404).send('Customer not found');
    let message;
    if(action==='extend')message=await performExtend(req);
    else if(action==='expiry')message=await performExpiry(req);
    else if(action==='suspend')message=await performSuspend(req);
    else message=await performJellyfinDelete(req);
    return res.redirect(303,customerPath(customerId,'message',message));
  }catch(error){
    console.error('Individual customer admin action failed:',{customerId,action,error:clean(error.message||error,500)});
    return res.redirect(303,customerPath(customerId,'error',clean(error.message||error,400)||'Customer action failed.'));
  }
}

function bridgeLegacyCompactAction(req,res,next){
  const action=String(req.body?.action||'');
  const direct=LEGACY_BULK_BRIDGE.get(action);
  if(!direct)return next();
  if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
  const raw=Array.isArray(req.body?.customerId)?req.body.customerId:[req.body?.customerId];
  const ids=raw.map(value=>String(value||'').trim()).filter(Boolean);
  if(req.body?.selectAllMatching==='1'||ids.length!==1||!UUID.test(ids[0]))return res.redirect(303,'/admin/users?error='+encodeURIComponent('This action is available for one customer at a time.'));
  const suffix=(direct==='extend'||direct==='expiry')&&req.body?.subscriptionId?`?subscriptionId=${encodeURIComponent(req.body.subscriptionId)}`:'';
  return res.redirect(303,actionPath(ids[0],direct)+suffix);
}

function createAdminCustomerIndividualActionsRouter(){
  const router=express.Router();
  // Compatibility bridge for compact Customer 360 requests created before the
  // direct action links were introduced. No mutation happens on this bridge.
  router.post('/admin/customers/bulk/preview',gate,noStore,bridgeLegacyCompactAction);
  router.get('/admin/users/:customerId/actions/:action',gate,noStore,renderAction);
  router.post('/admin/users/:customerId/actions/:action',gate,noStore,writeLimit,performAction);
  return router;
}

module.exports={
  DIRECT_ACTIONS,
  LEGACY_BULK_BRIDGE,
  createAdminCustomerIndividualActionsRouter,
  currentSubscription,
  subscriptionForCustomer,
  jellyfinAccounts,
  performExtend,
  performExpiry,
  performSuspend,
  performJellyfinDelete,
  bridgeLegacyCompactAction
};
