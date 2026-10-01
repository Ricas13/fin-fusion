'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');
const {subscriptionForCustomer}=require('./admin-customer-individual-actions');
const subscriptionState=require('../entitlements/subscription-state');
const serviceScope=require('../entitlements/service-scope');
const planExpiry=require('../entitlements/plan-expiry');
const deletion=require('../customers/customer-deletion');
const lifecycleService=require('../access/admin-customer-lifecycle-service');
const {applyLocalPlanContract}=lifecycleService;
const {ownerStatus}=require('../auth/owner-guard');

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const readLimit=routeRateLimit.middleware({scope:'admin-customer-direct-lifecycle-read',max:120,windowSeconds:60,reason:'admin_customer_direct_lifecycle_read'});
const writeLimit=routeRateLimit.middleware({scope:'admin-customer-direct-lifecycle-write',max:30,windowSeconds:60,reason:'admin_customer_direct_lifecycle_write'});

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function customerPath(customerId,key='',message=''){const notice=key?`&${encodeURIComponent(key)}=${encodeURIComponent(message)}`:'';return `/admin/users/${encodeURIComponent(customerId)}?tab=access${notice}`;}
function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function serviceType(row){return String(row?.service_type_snapshot||row?.service_type||'jellyfin').toLowerCase();}
function jellyfinCapable(row){return serviceScope.capabilities(row).has('jellyfin');}

async function customer(customerId){const result=await query(`SELECT c.id,COALESCE(NULLIF(c.display_name,''),u.username,c.email,'Customer') AS name FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[customerId]);return result.rows[0]||null;}
function pageShell(c,title,description,content){const body=`<section class="section"><div class="sectionHead"><div><h2>${esc(title)}</h2><div class="muted">${esc(c.name)} · ${esc(description)}</div></div><a class="button secondary" href="${esc(customerPath(c.id))}">Back to customer</a></div>${content}</section>`;return layout({siteName:runtimeSettings.siteName(),active:'users',title,subtitle:c.name,body});}

async function planChoices(sub){const result=await query(`SELECT * FROM plans WHERE active=TRUE AND visible=TRUE AND archived_at IS NULL AND COALESCE(is_addon,FALSE)=FALSE AND audience='direct' AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) ORDER BY is_free_tier DESC,sort_order,price_minor,name`);return result.rows.filter(plan=>serviceScope.overlaps(sub,plan)&&jellyfinCapable(plan)&&!(subscriptionState.recurringProvider(sub)&&planExpiry.isFreeTier(plan)));}
async function serverChoices(){const result=await query(`SELECT id,name,server_class,location,health_status FROM jellyfin_servers WHERE enabled=TRUE AND COALESCE(media_server_type,'jellyfin')='jellyfin' ORDER BY CASE health_status WHEN 'healthy' THEN 0 WHEN 'degraded' THEN 1 ELSE 2 END,priority,name`);return result.rows;}

async function changePlanPage(req,res,next){try{await runtimeSettings.ensureLoaded();const c=await customer(req.params.customerId);if(!c)return res.status(404).send('Customer not found');const sub=await subscriptionForCustomer(c.id,req.query.subscriptionId),plans=await planChoices(sub),subId=sub.id||sub.subscription_id,provider=String(sub.source||'').toLowerCase();const options=plans.map(plan=>`<option value="${esc(plan.id)}" ${String(plan.id)===String(sub.plan_id)?'disabled':''}>${esc(plan.name||plan.code||plan.id)} · ${esc(serviceType(plan))}</option>`).join('');const billingNotice=subscriptionState.recurringProvider(sub)?(provider==='stripe'?'Stripe billing is changed through the canonical provider workflow. Upgrades may apply immediately with proration; downgrades are normally scheduled for the next renewal.':'PayPal billing is changed through the canonical provider workflow. An active PayPal renewal must be stopped before a different plan can be scheduled, and a fresh PayPal authorization may be required.'):'This local/admin subscription will be updated directly; no external recurring billing contract is changed.';const form=`<div class="notice"><strong>Individual plan move.</strong> Only subscription ${esc(subId)} is targeted. ${esc(billingNotice)}</div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(c.id)}/change-plan" data-native-submit="true">${csrfHidden(csrf.token(req))}<input type="hidden" name="subscriptionId" value="${esc(subId)}"><div class="formGroup"><label>Move to plan</label><select class="input" name="planId" required><option value="">Choose a compatible Jellyfin plan…</option>${options}</select></div><div class="formGroup"><label>Type MOVE to confirm</label><input class="input" name="confirmWord" required></div><button class="button btn-danger" type="submit">Move this subscription</button></form>`;return res.send(pageShell(c,'Change plan','Individual customer action',form));}catch(error){return next(error);}}

async function changePlan(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
  try{
    if(String(req.body.confirmWord||'').trim().toUpperCase()!=='MOVE')throw new Error('Type MOVE exactly to confirm.');
    const planId=clean(req.body.planId,80);
    if(!UUID.test(planId))throw new Error('Choose a target plan.');
    const result=await lifecycleService.changePlan({
      customerId:req.params.customerId,
      subscriptionId:req.body.subscriptionId,
      targetPlanId:planId,
      actorUserId:req.session.authUserId
    });
    return res.redirect(303,customerPath(req.params.customerId,'message',result.message));
  }catch(error){
    return res.redirect(303,customerPath(req.params.customerId,'error',clean(error.message||error,400)));
  }
}

async function moveServerPage(req,res,next){try{await runtimeSettings.ensureLoaded();const c=await customer(req.params.customerId);if(!c)return res.status(404).send('Customer not found');const servers=await serverChoices(),options=servers.map(server=>`<option value="${esc(server.id)}">${esc(server.name)} · ${esc(server.health_status||'unknown')} · ${esc(server.server_class||'custom')}${server.location?` · ${esc(server.location)}`:''}</option>`).join('');const form=`<div class="notice"><strong>Individual server move.</strong> The existing administrator move service re-checks plan compatibility, placement, server state and capacity before moving this customer.</div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(c.id)}/move-server" data-native-submit="true">${csrfHidden(csrf.token(req))}<div class="formGroup"><label>Destination server</label><select class="input" name="serverId" required><option value="">Choose a server…</option>${options}</select></div><div class="formGroup"><label>Type MOVE to confirm</label><input class="input" name="confirmWord" required></div><button class="button btn-danger" type="submit">Move this customer</button></form>`;return res.send(pageShell(c,'Move Jellyfin server','Individual customer action',form));}catch(error){return next(error);}}
async function moveServer(req,res){
  if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
  try{
    if(String(req.body.confirmWord||'').trim().toUpperCase()!=='MOVE')throw new Error('Type MOVE exactly to confirm.');
    const serverId=clean(req.body.serverId,80);
    if(!UUID.test(serverId))throw new Error('Choose a destination server.');
    const result=await lifecycleService.moveServer(req.params.customerId,serverId,{actorUserId:req.session.authUserId});
    return res.redirect(303,customerPath(req.params.customerId,'message',`Jellyfin access moved to ${result.target.name}. Automatic placement will keep this administrator-selected server.`));
  }catch(error){
    return res.redirect(303,customerPath(req.params.customerId,'error',clean(error.message||error,400)));
  }
}

async function deleteCustomerPage(req,res,next){try{await runtimeSettings.ensureLoaded();const c=await customer(req.params.customerId);if(!c)return res.status(404).send('Customer not found');if(!(await ownerStatus(req.session.authUserId)))return res.status(403).send(pageShell(c,'Delete customer completely','Owner access required','<div class="notice error">Only the owner account can permanently delete a portal customer.</div>'));const form=`<div class="notice error"><strong>Permanent customer deletion.</strong> This uses the existing durable deletion saga and verifies external cleanup before finalizing the portal customer. This cannot be undone from the portal.</div><form class="formPanel" method="post" action="/admin/users/${encodeURIComponent(c.id)}/delete-customer" data-native-submit="true">${csrfHidden(csrf.token(req))}<div class="formGroup"><label>Administrator reason</label><input class="input" name="reason" minlength="3" maxlength="500" required></div><div class="formGroup"><label>Type DELETE CUSTOMER to confirm</label><input class="input" name="confirmWord" required></div><button class="button btn-danger" type="submit">Permanently delete customer</button></form>`;return res.send(pageShell(c,'Delete customer completely','Owner-only individual action',form));}catch(error){return next(error);}}
async function deleteCustomer(req,res){if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');try{if(!(await ownerStatus(req.session.authUserId)))return res.status(403).send('Owner access is required for this administrative action.');if(String(req.body.confirmWord||'').trim().toUpperCase()!=='DELETE CUSTOMER')throw new Error('Type DELETE CUSTOMER exactly to confirm.');const reason=clean(req.body.reason,500);if(reason.length<3)throw new Error('Enter a deletion reason of at least 3 characters.');await deletion.hardDeletePortalCustomer(req.params.customerId,{actorUserId:req.session.authUserId,reason});return res.redirect(303,'/admin/users?message='+encodeURIComponent('Customer deletion completed.'));}catch(error){return res.redirect(303,customerPath(req.params.customerId,'error',clean(error.message||error,400)));}}

function createAdminCustomerDirectLifecycleRouter(){const router=express.Router();router.get('/admin/users/:customerId/change-plan',gate,noStore,readLimit,changePlanPage);router.post('/admin/users/:customerId/change-plan',gate,noStore,writeLimit,changePlan);router.get('/admin/users/:customerId/move-server',gate,noStore,readLimit,moveServerPage);router.post('/admin/users/:customerId/move-server',gate,noStore,writeLimit,moveServer);router.get('/admin/users/:customerId/delete-customer',gate,noStore,readLimit,deleteCustomerPage);router.post('/admin/users/:customerId/delete-customer',gate,noStore,writeLimit,deleteCustomer);return router;}

module.exports={createAdminCustomerDirectLifecycleRouter,applyLocalPlanContract,changePlan,moveServer,deleteCustomer};
