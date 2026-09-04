'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const permanentAccess=require('../entitlements/permanent-access');
const subscriptionState=require('../entitlements/subscription-state');
const provisioning=require('../jellyfin/resilient-provisioning');
const manualAssignment=require('../jellyfin/manual-assignment');
const forceMove=require('../jellyfin/admin-force-move');
const adminControl=require('../jellyfin/admin-control');
const operator=require('./admin-customer-operator');
const {esc}=require('./admin-html');

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function clean(value,max=500){return String(value==null?'':value).trim().slice(0,max);}
function uuid(value){return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(value||''));}
function path(customerId,key,message){return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${encodeURIComponent(key)}=${encodeURIComponent(message)}`;}
function serviceType(entitlement){return String(entitlement?.service_type_snapshot||entitlement?.service_type||'jellyfin').toLowerCase();}
function csrfHidden(token){return `<input type="hidden" name="_csrf" value="${esc(token)}">`;}
function breakGlassControls(customerId,token){return `<div class="breakGlassControls"><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manage/force/reconcile" data-native-submit="true">${csrfHidden(token)}<button class="button secondary sm" type="submit">FORCE RECONCILE NOW</button></form><form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/manage/force/clear-blockers" data-native-submit="true">${csrfHidden(token)}<button class="button danger sm" type="submit">CLEAR ALL BLOCKERS</button></form></div>`;}

async function forceAccess(customerId,serverId,{actorUserId=null}={}){
  const initial=await manualAssignment.candidates(customerId);
  if(!initial.entitlement)throw new Error('This customer does not have a Jellyfin plan. Add a Jellyfin or bundle plan first.');
  if(!['jellyfin','bundle'].includes(serviceType(initial.entitlement)))throw new Error('The current plan does not include Jellyfin access.');
  const target=initial.servers.find(server=>String(server.id)===String(serverId));
  if(!target)throw new Error('Choose an enabled Jellyfin server.');

  // A deliberate operator force is stronger than payment-risk, expiry and
  // inactivity automation. Keep the commercial incident/hold recorded, but
  // pin this effective subscription so reconciliation cannot immediately undo
  // the administrator's repair.
  await permanentAccess.enable(customerId,{actorUserId,reason:`Forced Jellyfin access to ${target.name} by administrator`});

  const current=await manualAssignment.candidates(customerId);
  const active=current.activeAccounts||[];
  const onTarget=active.find(account=>String(account.server_id)===String(target.id));
  let result;
  if(onTarget){
    await adminControl.forceServer(customerId,current.entitlement.subscription_id,target.id,{actorUserId,reason:'Forced Jellyfin access by administrator'});
    await provisioning.reconcileCustomer(customerId);
    result={server:target,account:onTarget,action:'kept'};
  }else if(active.length){
    const moved=await forceMove.move(customerId,target.id,{actorUserId});
    result={server:moved.target,account:moved.targetAccount,action:'moved'};
  }else{
    const assigned=await manualAssignment.assign(customerId,target.id,{actorUserId});
    result={server:assigned.server,account:assigned.account,action:'assigned'};
  }

  return result;
}

async function returnToPlanRules(customerId,{actorUserId=null}={}){
  const entitlement=await subscriptionState.effectiveSubscription(customerId,{includeBlocked:true}).catch(()=>null);
  if(entitlement?.subscription_id){
    await adminControl.clear(customerId,entitlement.subscription_id,{actorUserId,reason:'Returned to normal plan and billing rules'});
  }
  await permanentAccess.revoke(customerId,{actorUserId,reason:'Returned to normal plan and billing rules'});
  let warning='';
  try{await provisioning.reconcileCustomer(customerId);}catch(error){warning=clean(error.message||error,240);}
  return{warning};
}

async function panel(detail,token,req,permanent){
  if(!detail?.customer?.id)return'';
  const customerId=detail.customer.id;
  const emergency=breakGlassControls(customerId,token);
  const ctx=await operator.context(customerId,req).catch(()=>null);
  if(!ctx)return `${styles()}<section class="forceAccessBar breakGlassOnly"><div class="forceAccessCopy"><strong>Admin override</strong><span>Customer state could not be fully loaded. Emergency controls are still available.</span></div>${emergency}</section>`;
  const entitlement=ctx.entitlement;
  if(!entitlement||!['jellyfin','bundle'].includes(String(entitlement.serviceType||'jellyfin').toLowerCase())){
    return `${styles()}<section class="forceAccessBar breakGlassOnly"><div class="forceAccessCopy"><strong>Admin override</strong><span>No Jellyfin plan to pin. You can still clear every access hold or force the reconciliation worker to retry immediately.</span></div>${emergency}</section>`;
  }
  const servers=(ctx.servers||[]).filter(server=>server.operable);
  const options=servers.map(server=>{
    const max=Number(server.max_users||0),used=Number(server.assigned_users||0);
    const capacity=max?`${used}/${max}`:`${used} users`;
    const warnings=[];
    if(server.server_class!==entitlement.serverClass)warnings.push('different plan pool');
    if(!server.allow_new_users)warnings.push('closed to automatic users');
    if(server.health_status&&server.health_status!=='healthy')warnings.push(server.health_status);
    if(server.full)warnings.push('capacity full');
    return `<option value="${esc(server.id)}" ${String(ctx.adminControl?.serverId||'')===String(server.id)?'selected':''}>${esc(server.name)} · ${esc(capacity)}${warnings.length?` · ${esc(warnings.join(', '))}`:''}</option>`;
  }).join('');
  const forced=Boolean(permanent?.active||ctx.adminControl?.mode==='forced_server');
  const status=forced?`Admin force active${ctx.adminControl?.serverName?` · ${ctx.adminControl.serverName}`:''}`:(entitlement.blocked?'Plan exists but access is currently blocked':'Following normal plan rules');
  const form=servers.length?`<form class="forceAccessForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/force-jellyfin-access" data-native-submit="true">${csrfHidden(token)}<select class="input" name="serverId" required><option value="">Choose any Jellyfin server…</option>${options}</select><button class="button primary" type="submit">FORCE JELLYFIN ACCESS</button></form>`:'<span class="forceAccessProblem">No enabled Jellyfin servers are configured.</span>';
  const reset=forced?`<form class="plainForm" method="post" action="/admin/users/${encodeURIComponent(customerId)}/force-jellyfin-access/reset" data-native-submit="true">${csrfHidden(token)}<button class="button secondary sm" type="submit">Return to plan rules</button></form>`:'';
  return `${styles()}<section class="forceAccessBar ${forced?'isForced':''}"><div class="forceAccessCopy"><strong>Admin override / break glass</strong><span>${esc(status)}. Force Jellyfin access ignores payment/refund holds, expiry, server-pool admission and capacity. CLEAR ALL BLOCKERS releases every active hold regardless of workflow ownership. Provider billing is never changed by these controls.</span></div><div class="forceAccessStack">${form}${emergency}</div>${reset}</section>`;
}

function styles(){return `<style>
.forceAccessBar{display:grid;grid-template-columns:minmax(240px,.95fr) minmax(420px,1.45fr) auto;gap:10px;align-items:center;border:1px solid color-mix(in srgb,var(--warning,#e0ad5c) 55%,var(--border,#29333d));border-radius:10px;padding:10px 12px;margin:10px 0 12px;background:color-mix(in srgb,var(--warning,#e0ad5c) 5%,transparent)}
.forceAccessBar.isForced{border-color:color-mix(in srgb,var(--danger,#e16c72) 60%,var(--border,#29333d))}.forceAccessBar.breakGlassOnly{grid-template-columns:minmax(260px,1fr) auto}.forceAccessCopy{display:grid;gap:2px}.forceAccessCopy strong{font-size:.8rem}.forceAccessCopy span,.forceAccessProblem{font-size:.67rem;color:var(--muted,#9aa7b5);line-height:1.35}.forceAccessStack{display:grid;gap:6px}.forceAccessForm{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:7px}.forceAccessForm .input{min-width:0}.forceAccessForm .button{white-space:nowrap}.breakGlassControls{display:flex;gap:6px;flex-wrap:wrap}.breakGlassControls .button{white-space:nowrap}@media(max-width:1000px){.forceAccessBar,.forceAccessBar.breakGlassOnly{grid-template-columns:1fr}.forceAccessForm{grid-template-columns:1fr}}
</style>`;}

function createAdminCustomerForceAccessRouter(){
  const router=express.Router();
  router.use('/admin/users',gate,noStore);
  router.post('/admin/users/:customerId/force-jellyfin-access',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId,serverId=clean(req.body.serverId,80);
    try{
      if(!uuid(serverId))throw new Error('Choose a Jellyfin server.');
      const result=await forceAccess(customerId,serverId,{actorUserId:req.session.authUserId});
      return res.redirect(path(customerId,'message',`Jellyfin access forced on ${result.server.name}. Refund/payment holds remain recorded, but they cannot remove this access until you return the customer to plan rules.`));
    }catch(error){
      console.error('Forced Jellyfin access failed:',{customerId,error:error.message});
      return res.redirect(path(customerId,'error',`Could not force Jellyfin access. ${clean(error.message||error,300)}`));
    }
  });
  router.post('/admin/users/:customerId/force-jellyfin-access/reset',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    const customerId=req.params.customerId;
    try{
      const result=await returnToPlanRules(customerId,{actorUserId:req.session.authUserId});
      const message=result.warning?`Returned to normal plan rules, but reconciliation needs attention: ${result.warning}`:'Returned to normal plan, billing and access rules.';
      return res.redirect(path(customerId,result.warning?'error':'message',message));
    }catch(error){
      return res.redirect(path(customerId,'error',`Could not return to normal plan rules. ${clean(error.message||error,300)}`));
    }
  });
  return router;
}

module.exports={createAdminCustomerForceAccessRouter,forceAccess,returnToPlanRules,panel,styles,breakGlassControls};