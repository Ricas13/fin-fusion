'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');
const revokeService=require('../entitlements/admin-subscription-revoke-service');

const {
  serviceType,
  recurring,
  serviceLabel,
  roleLabel,
  subscriptions,
  ownedSubscription,
  revokeSelected,
  cleanupStremio
}=revokeService;

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function text(value,max=500){return String(value||'').trim().slice(0,max);}
function dt(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function backPath(customerId,key='',message=''){const notice=key?`&${encodeURIComponent(key)}=${encodeURIComponent(message)}`:'';return `/admin/users/${encodeURIComponent(customerId)}?tab=access${notice}`;}

async function customer(customerId){const result=await query(`SELECT c.id,COALESCE(c.display_name,u.username,c.email,'Customer') name,COALESCE(c.email,u.email) email FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[customerId]);return result.rows[0]||null;}

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
