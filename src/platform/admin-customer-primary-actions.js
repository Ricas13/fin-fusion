'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');
const permanentAccess=require('../entitlements/permanent-access');
const serviceAdminControl=require('../entitlements/service-admin-control');
const provisioning=require('../jellyfin/resilient-provisioning');
const requestUserSync=require('../integrations/request-user-sync');
const forceAccess=require('./admin-customer-force-access');
const {esc}=require('./admin-html');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function path(customerId,key,message){return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${encodeURIComponent(key)}=${encodeURIComponent(message)}`;}
function buttonForm(token,action,label,{tone='secondary',fields={}}={}){return `<form class="plainForm" method="post" action="${esc(action)}" data-native-submit="true">${csrfHidden(token)}${Object.entries(fields).map(([name,value])=>`<input type="hidden" name="${esc(name)}" value="${esc(value)}">`).join('')}<button class="button ${esc(tone)} sm" type="submit">${esc(label)}</button></form>`;}
function bulkForm(token,customerId,action,label,tone='secondary'){return `<form class="plainForm" method="post" action="/admin/customers/bulk/preview">${csrfHidden(token)}<input type="hidden" name="customerId" value="${esc(customerId)}"><input type="hidden" name="action" value="${esc(action)}"><button class="button ${esc(tone)} sm" type="submit">${esc(label)}</button></form>`;}

async function returnToNormalAutomation(customerId,{actorUserId=null}={}){
  const reason='Returned customer to normal automation';
  const permanent=await permanentAccess.revoke(customerId,{actorUserId,reason});
  const authority={};
  for(const service of ['jellyfin','stremio','overseerr'])authority[service]=await serviceAdminControl.clear(customerId,service,{actorUserId,reason});
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.return_to_normal_automation','customer',$2,$3::jsonb)`,[
    actorUserId,customerId,JSON.stringify({permanentAccessRevoked:Boolean(permanent.changed),services:Object.fromEntries(Object.entries(authority).map(([service,result])=>[service,Boolean(result.changed)])),providerBillingChanged:false})
  ]);
  const warnings=[];
  try{await provisioning.reconcileCustomer(customerId);}catch(error){warnings.push(`media: ${String(error.message||error).slice(0,180)}`);}
  try{await requestUserSync.syncOneCustomer(customerId);}catch(error){warnings.push(`request service: ${String(error.message||error).slice(0,180)}`);}
  return{permanent,authority,warnings};
}

async function panel(detail,token,req,permanent){
  if(!detail?.customer?.id)return'';
  const id=detail.customer.id;
  const active=(detail.subscriptions||[]).filter(row=>['active','trialing','past_due','paused'].includes(String(row.status||''))&&(!row.current_period_end||new Date(row.current_period_end)>new Date()));
  const paid=active.find(row=>!row.is_free_tier)||null;
  const jellyfin=(detail.accounts||[]).filter(row=>String(row.account_purpose||'jellyfin')!=='stremio_internal'&&String(row.media_server_type||'jellyfin')!=='emby');
  const resetNeeded=Boolean(permanent?.active||permanent?.stale)||Boolean(detail.customer.automation_protected);
  const resetCopy=paid?'Keep the active paid plan, remove legacy permanent/admin overrides and let billing + plan rules manage access again.':'Remove legacy permanent/admin overrides and return every service to its normal plan rules.';
  const portal=detail.customer.app_user_id?`<form class="plainForm customerPrimaryPortal" method="post" action="/admin/users/${encodeURIComponent(id)}/impersonate">${csrfHidden(token)}<button class="button secondary sm" type="submit">View portal</button></form>`:'';
  const normal=`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(id)}/manage/normal-automation" data-native-submit="true">${csrfHidden(token)}<button class="button primary sm" type="submit">Return to normal automation</button></form>`;
  const planActions=`<a class="button secondary sm" href="#customer-plans">Plans & billing</a>`;
  const move=jellyfin.length?bulkForm(token,id,'migrate_server','Move Jellyfin server'):'';
  const password=jellyfin.length?`<a class="button secondary sm" href="/admin/customer-jellyfin-password?customerId=${encodeURIComponent(id)}">Reset Jellyfin password</a>`:'';
  const reconcile=buttonForm(token,`/admin/users/${encodeURIComponent(id)}/manage/reconcile`,'Fix / reconcile access');
  const advanced=await forceAccess.panel(detail,token,req,permanent).catch(()=> '');
  return `${styles()}<section class="customerPrimaryActions" data-customer-primary-actions><div class="customerPrimaryHead"><div><h2>Customer actions</h2><p>Choose the outcome you want. Normal actions are here; implementation-level recovery tools are hidden under Advanced.</p></div>${resetNeeded?'<span class="pill warn">Admin override active</span>':paid?'<span class="pill good">Paid automation</span>':'<span class="pill">Automatic</span>'}</div><div class="customerPrimaryReset"><div><strong>Return this customer to normal automation</strong><span>${esc(resetCopy)}</span></div>${normal}</div><div class="customerPrimaryButtons">${portal}${planActions}${move}${password}${reconcile}</div><details class="customerAdvanced"><summary>Advanced / recovery tools <span>Force placement, break-glass reconciliation and legacy blocker repair</span></summary><div class="customerAdvancedBody">${advanced||'<div class="muted">No advanced recovery controls are available for this customer.</div>'}</div></details></section>`;
}

function styles(){return `<style>
.customerPrimaryActions{border:1px solid var(--border,#29333d);border-radius:11px;padding:12px;margin:10px 0 12px;background:rgba(255,255,255,.018)}.customerPrimaryHead{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:10px}.customerPrimaryHead h2{font-size:.9rem;margin:0}.customerPrimaryHead p{font-size:.68rem;color:var(--muted,#9aa7b5);margin:3px 0 0}.customerPrimaryReset{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:9px 10px;border:1px solid color-mix(in srgb,var(--accent,#57d9bd) 30%,var(--border,#29333d));border-radius:9px;background:color-mix(in srgb,var(--accent,#57d9bd) 4%,transparent)}.customerPrimaryReset>div{display:grid;gap:2px}.customerPrimaryReset strong{font-size:.76rem}.customerPrimaryReset span{font-size:.65rem;color:var(--muted,#9aa7b5);line-height:1.35}.customerPrimaryButtons{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px}.customerAdvanced{margin-top:9px;border-top:1px solid var(--border,#29333d);padding-top:8px}.customerAdvanced>summary{cursor:pointer;list-style:none;font-size:.7rem;font-weight:800}.customerAdvanced>summary::-webkit-details-marker{display:none}.customerAdvanced>summary span{font-weight:500;color:var(--muted,#9aa7b5);margin-left:8px}.customerAdvancedBody{margin-top:8px}.customerAdvancedBody .forceAccessBar{margin:0}.customerPrimaryPortal{display:inline-flex}@media(max-width:760px){.customerPrimaryHead,.customerPrimaryReset{align-items:stretch;flex-direction:column}.customerPrimaryReset .button{width:100%}}
</style>`;}

function createAdminCustomerPrimaryActionsRouter(){
  const router=express.Router();
  router.use('/admin/users',gate,noStore);
  router.post('/admin/users/:customerId/manage/normal-automation',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{
      const result=await returnToNormalAutomation(req.params.customerId,{actorUserId:req.session.authUserId});
      if(result.warnings.length)return res.redirect(path(req.params.customerId,'error',`Returned to normal automation, but reconciliation needs attention: ${result.warnings.join(' · ')}`));
      return res.redirect(path(req.params.customerId,'message','Returned to normal automation. Valid plans were kept; permanent access, admin service overrides and server pinning were removed.'));
    }catch(error){
      return res.redirect(path(req.params.customerId,'error',`Could not return to normal automation. ${String(error.message||error).slice(0,300)}`));
    }
  });
  return router;
}

module.exports={createAdminCustomerPrimaryActionsRouter,returnToNormalAutomation,panel,styles};
