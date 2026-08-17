'use strict';

const express=require('express');
const crypto=require('crypto');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const monthly=require('../resellers/monthly');
const resellerSettings=require('../resellers/settings');
const provisioning=require('../jellyfin/provisioning');
const productReadiness=require('./product-readiness');
const runtimeSettings=require('./runtime-settings');
const core=require('./reseller-monthly-portal-core');
const legacy=require('./reseller-monthly-portal');
const branding=require('./branding');
const {esc}=require('./admin-html');

const saleLimit=routeRateLimit.middleware({scope:'reseller-service-sale',max:30,windowSeconds:300});
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='reseller'?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function re(value){return String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');}
function delivery(plan){return productReadiness.serviceType(plan);}
function deliveryLabel(plan){return productReadiness.deliveryLabel(plan);}
function optionText(plan){return `${plan.name} · ${deliveryLabel(plan)} · ${Number(plan.duration_days||30)} days`;}
function injectScript(html){return String(html).includes('/js/reseller-service-aware.js')?html:String(html).replace('</body>','<script src="/js/reseller-service-aware.js" defer></script></body>');}
function decorateOptions(html,plans,{allowStremio=true}={}){
  let out=String(html);
  for(const plan of plans||[]){
    const type=delivery(plan),pattern=new RegExp(`<option value="${re(esc(plan.code))}"([^>]*)>[^<]*<\\/option>`,'g');
    if(!allowStremio&&type!=='jellyfin'){out=out.replace(pattern,'');continue;}
    out=out.replace(pattern,(_whole,attrs)=>`<option value="${esc(plan.code)}" data-service-type="${esc(type)}"${attrs}>${esc(optionText(plan))}</option>`);
  }
  return out;
}
function decorateCreateForm(html,d){
  let out=String(html),match=out.match(/<form class="formPanel" method="post" action="\/reseller\/customer\/create">[\s\S]*?<\/form>/);
  if(!match)return out;
  let form=decorateOptions(match[0],d.plans,{allowStremio:d.cfg.customerPortalPolicy!=='jellyfin_only'});
  form=form.replace('<label>Jellyfin username</label>','<label>Customer username</label>')
    .replace('name="planCode"','name="planCode" data-reseller-plan')
    .replace('name="createPortal" value="1"','name="createPortal" value="1" data-reseller-create-portal')
    .replace('name="email" maxlength="254"','name="email" maxlength="254" data-reseller-portal-email data-portal-required="'+(d.cfg.customerPortalPolicy==='portal_required'?'1':'0')+'"')
    .replace('Create customer & provision Jellyfin','Create customer & deliver access');
  if(d.cfg.customerPortalPolicy!=='jellyfin_only')form=form.replace('<button class="button">Create customer & deliver access</button>','<div class="notice warn" data-reseller-portal-note hidden><strong>Stremio delivery needs a portal account.</strong> The customer uses that portal to create, rotate or revoke their private Stremio installation.</div><button class="button">Create customer & deliver access</button>');
  return out.replace(match[0],form);
}
function decorateOwnerForm(html,plans){
  const match=String(html).match(/<form class="formPanel" method="post" action="\/reseller\/owner\/create">[\s\S]*?<\/form>/);if(!match)return html;
  const form=decorateOptions(match[0],plans,{allowStremio:false});return String(html).replace(match[0],form);
}
function decorateCustomerActions(html,customers){
  let out=String(html);
  for(const customer of customers||[]){
    if(delivery(customer)!=='stremio')continue;
    const href=`/reseller/customer/${customer.id}/credentials`,pattern=new RegExp(`<a class="button secondary btn-sm" href="${re(href)}">Credentials<\\/a>`,'g');
    out=out.replace(pattern,customer.user_id?'<span class="pill good">Stremio · portal managed</span>':'<span class="pill warn">Portal activation needed</span>');
  }
  return out;
}
async function dashboard(req){
  const [html,d]=await Promise.all([legacy.dashboard(req),core.dashboardData(req)]);
  let out=decorateCreateForm(html,d);out=decorateOwnerForm(out,d.plans);out=decorateCustomerActions(out,d.customers);return injectScript(out);
}
async function manage(req){
  const reseller=await core.resolveReseller(req.session.authUserId),customer=await monthly.getResellerCustomer(reseller.id,req.params.id);if(!customer)return null;
  const subscription=await monthly.currentSubscription(reseller.id);const plans=subscription?await resellerSettings.eligiblePlans(subscription.tier_id):[];
  const allowed=customer.user_id?plans:plans.filter(plan=>delivery(plan)==='jellyfin');let html=await legacy.managePage(req);if(!html)return null;
  html=decorateOptions(html,plans,{allowStremio:Boolean(customer.user_id)}).replace('name="planCode"','name="planCode" data-reseller-plan');
  if(!customer.user_id&&plans.some(plan=>delivery(plan)!=='jellyfin'))html=html.replace('<section class="section"><div class="sectionHead"><h2>Renew or change plan</h2>','<div class="notice warn"><strong>Stremio plans are hidden for this customer.</strong> A CAPTAiNFiN portal identity is required before switching them to Stremio or a bundle.</div><section class="section"><div class="sectionHead"><h2>Renew or change plan</h2>');
  if(!allowed.length)html=html.replace('<button class="button">Record sale & apply lifecycle</button>','<button class="button" disabled>No deliverable plans available</button>');
  return injectScript(html);
}
async function prevalidatePortal(req,cfg){
  const wantsPortal=cfg.customerPortalPolicy==='portal_required'||(cfg.customerPortalPolicy==='optional'&&req.body.createPortal==='1');
  if(!wantsPortal)return{wantsPortal:false};
  const email=String(req.body.email||'').trim().toLowerCase(),username=String(req.body.username||'').trim();
  if(!email||!email.includes('@'))throw new Error('Customer email is required for a portal activation.');
  const duplicate=await query(`SELECT 1 FROM app_users WHERE lower(username)=lower($1) OR lower(COALESCE(email,''))=lower($2) LIMIT 1`,[username,email]);
  if(duplicate.rowCount)throw new Error('That portal username or email is already in use.');
  return{wantsPortal:true,email};
}
function credentialsPage(site,username,password,message,portal,serviceType){
  const stremio=serviceType==='bundle'?'<div class="notice success"><strong>Stremio is included too.</strong> The customer manages their private Stremio installation from their CAPTAiNFiN portal after activation.</div>':'';
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>Access ready · ${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><link rel="stylesheet" href="/css/admin-original-base.css"><link rel="stylesheet" href="/css/admin-original-components.css"><link rel="stylesheet" href="/css/customer-360.css"></head><body><main style="max-width:760px;margin:40px auto;padding:20px"><section class="section"><div class="formPanel"><h1>Customer access ready</h1><p>${esc(message)}</p>${stremio}<p><strong>Jellyfin username</strong></p><div class="codeBox">${esc(username)}</div><p><strong>Jellyfin password</strong></p><div class="codeBox">${esc(password)}</div><p class="muted">Shown once. Share it securely and ask the customer to change it.</p>${portal?`<hr><p><strong>CAPTAiNFiN portal activation</strong></p><p>${portal.queued?`Activation email queued to ${esc(portal.email)}.`:`Email could not be queued; share the one-time link below.`}</p><div class="codeBox">${esc(portal.activationLink)}</div>`:''}<p><a class="button" href="/reseller">Back to dashboard</a></p></div></section></main></body></html>`;
}
async function createCustomer(req,res){
  try{
    const reseller=await core.resolveReseller(req.session.authUserId),cfg=await resellerSettings.forReseller(reseller.id),portalIntent=await prevalidatePortal(req,cfg);
    const result=await monthly.createOrRenewCustomer({resellerId:reseller.id,username:req.body.username,planCode:req.body.planCode,amount:req.body.amount,currency:req.body.currency,paymentMethod:req.body.paymentMethod,note:req.body.note,actorUserId:req.session.authUserId,portalReady:portalIntent.wantsPortal});
    const portal=await legacy.attachPortalAccount(req,reseller,result,cfg),service=delivery(result.plan);
    if(service==='stremio')return res.redirect('/reseller?message='+encodeURIComponent(portal?.queued?'Customer created. Portal activation was emailed; the customer can create their Stremio installation after activation.':'Customer created with Stremio delivery. Share the portal activation link so they can manage their private installation.'));
    if(!result.reconcile?.account?.id)return res.redirect('/reseller?message='+encodeURIComponent(service==='bundle'?'Customer and portal created; Jellyfin provisioning is queued and Stremio will be available from their portal.':'Customer and sale recorded; Jellyfin provisioning is queued.'));
    const password=`${crypto.randomBytes(18).toString('base64url')}A1!`;await provisioning.setJellyfinPassword(result.customer.id,result.reconcile.account.id,password);await runtimeSettings.ensureLoaded();
    return res.send(credentialsPage(runtimeSettings.siteName(),result.reconcile.account.jellyfin_username||req.body.username,password,service==='bundle'?'Customer created with Jellyfin + Stremio delivery.':'Customer created and Jellyfin provisioned.',portal,service));
  }catch(error){return res.redirect('/reseller?error='+encodeURIComponent(error.message));}
}
async function renewCustomer(req,res){
  try{
    const reseller=await core.resolveReseller(req.session.authUserId),result=await monthly.createOrRenewCustomer({resellerId:reseller.id,customerId:req.params.id,planCode:req.body.planCode,amount:req.body.amount,currency:req.body.currency,paymentMethod:req.body.paymentMethod,note:req.body.note,changeMode:req.body.changeMode,actorUserId:req.session.authUserId}),label=deliveryLabel(result.plan),messages={renewal:`${label} sale recorded and existing access extended.`,scheduled_plan_change:`Sale recorded; ${label} delivery is scheduled for the current access-expiry date.`,immediate_plan_change:`Sale recorded; delivery changed immediately to ${label}.`,new:`${label} entitlement created.`};
    return res.redirect('/reseller?message='+encodeURIComponent(messages[result.operation]||'Customer lifecycle updated.'));
  }catch(error){return res.redirect(`/reseller/customer/${encodeURIComponent(req.params.id)}/renew?error=${encodeURIComponent(error.message)}`);}
}
function runLimited(middleware,req,res,handler){return middleware(req,res,error=>error?handler(error):handler());}
function createResellerServiceAwarePortalRouter(){
  const r=express.Router();
  r.use('/reseller',gate,noStore,async(req,res,next)=>{
    const path=String(req.path||'/'),method=String(req.method||'GET').toUpperCase();
    try{
      if(method==='GET'&&path==='/')return res.send(await dashboard(req));
      const renew=path.match(/^\/customer\/([^/]+)\/renew$/);
      if(method==='GET'&&renew){req.params.id=renew[1];const html=await manage(req);return html?res.send(html):res.status(404).send('Customer not found');}
      if(method==='POST'&&path==='/customer/create')return runLimited(saleLimit,req,res,error=>{if(error)return next(error);if(!csrf.verify(req))return res.status(403).send('Invalid security token');return createCustomer(req,res);});
      if(method==='POST'&&renew){req.params.id=renew[1];return runLimited(saleLimit,req,res,error=>{if(error)return next(error);if(!csrf.verify(req))return res.status(403).send('Invalid security token');return renewCustomer(req,res);});}
      return next();
    }catch(error){return next(error);}
  });
  return r;
}
module.exports={createResellerServiceAwarePortalRouter,dashboard,manage,decorateOptions,decorateCreateForm,decorateOwnerForm,decorateCustomerActions,createCustomer,renewCustomer};
