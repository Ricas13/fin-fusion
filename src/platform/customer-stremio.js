'use strict';

const express=require('express');
const {rateLimit,ipKeyGenerator}=require('express-rate-limit');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const operations=require('./operations-settings');
const runtimeSettings=require('./runtime-settings');
const customerNav=require('./customer-nav-html');
const provisioning=require('../jellyfin/provisioning');
const foundation=require('../stremio/foundation');
const stremio=require('../stremio/entitlements');
const managedEntitlements=require('../stremio/managed-entitlements');
const installRecovery=require('../stremio/install-credential-recovery');
const householdAccess=require('../stremio/household-access');

const mutateLimit=routeRateLimit.middleware({scope:'customer-stremio-install',max:10,windowSeconds:300});
const resetBurstLimit=rateLimit({windowMs:300_000,limit:10,keyGenerator:req=>req.session?.customerUserId?`customer:${req.session.customerUserId}`:ipKeyGenerator(req.ip),standardHeaders:false,legacyHeaders:false});
function guard(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/stremio'));}
function typeOf(row){return String(row?.service_type_snapshot||row?.service_type||'jellyfin');}
function stremioDeepLink(manifestUrl){const url=new URL(manifestUrl);return `stremio://${url.host}${url.pathname}${url.search}`;}
function householdLabel(limit){const value=Math.max(1,Number(limit||1));return `Unlimited streams · Unlimited devices · ${value} household connection${value===1?'':'s'}`;}
async function model(req,{credential=null,message=null,error=null}={}){
  await runtimeSettings.ensureLoaded();
  const [sub,row,navOptions]=await Promise.all([provisioning.currentEntitlement(req.session.customerId),stremio.current(req.session.customerId),customerNav.optionsForCustomer(req.session.customerId)]),eligible=Boolean(sub&&['stremio','bundle'].includes(typeOf(sub)));
  let effectiveCredential=credential;
  if(!effectiveCredential){const recovered=await installRecovery.current(req.session.customerId).catch(()=>null);effectiveCredential=recovered?.credential||null;}
  let manifestUrl=null,stremioUrl=null;
  if(effectiveCredential){manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(effectiveCredential)}/manifest.json`);stremioUrl=stremioDeepLink(manifestUrl);}
  const status=String(row?.status||'pending');
  let accessModel='Unlimited streams · Unlimited devices · 1 household connection',replacementState=null;
  if(eligible){
    const entitlement=row||{plan_id:sub.plan_id,subscription_id:sub.id,customer_id:req.session.customerId};
    const configured=await householdAccess.configForEntitlement(entitlement).catch(()=>null);
    if(configured)accessModel=householdLabel(configured.component.config.networkLimit);
    if(row&&status==='active')replacementState=await householdAccess.replacementState(row).catch(()=>null);
  }
  return{siteName:runtimeSettings.siteName(),csrfToken:csrf.token(req),navOptions,eligible,runtimeReady:foundation.runtimeReady(),status,statusLabel:row?status.replace(/^./,c=>c.toUpperCase()):'Not installed',accessModel,replacementState,tokenHint:row?.token_hint||null,credential:effectiveCredential,manifestUrl,stremioUrl,message,error};
}
async function preprovisionManaged(credential){
  try{const entitlement=await stremio.findByInstallToken(credential);if(entitlement)await managedEntitlements.ensure(entitlement);}catch(error){console.warn('Managed Stremio pre-provisioning deferred:',error.message);}
}
function createCustomerStremioRouter(){
  const r=express.Router();r.use('/account/stremio',guard);
  r.get('/account/stremio',async(req,res,next)=>{try{return res.render('customer/stremio',await model(req,{message:req.query.message||null,error:req.query.error||null}));}catch(e){next(e)}});
  r.post('/account/stremio/install',mutateLimit,async(req,res,next)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const issued=await stremio.issueInstallation(req.session.customerId);await installRecovery.save({customerId:req.session.customerId,entitlement:issued.entitlement,credential:issued.credential,actorUserId:req.session.customerUserId});await preprovisionManaged(issued.credential);return res.render('customer/stremio',await model(req,{credential:issued.credential,message:'Your new Stremio installation link is ready. Any previous installation link has been replaced for your security.'}));}catch(error){try{return res.status(400).render('customer/stremio',await model(req,{error:error.message}));}catch(e){next(e)}}});
  r.post('/account/stremio/reset-household',resetBurstLimit,mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const row=await stremio.current(req.session.customerId);if(!row||String(row.status||'')!=='active')throw new Error('No active household connection is available to replace.');const released=await householdAccess.release(row,{actorUserId:req.session.customerUserId,reason:'customer_reset',customerInitiated:true});return res.redirect('/account/stremio?message='+encodeURIComponent(released?'Household connection released. Your next Stremio playback will register the internet connection you are using now.':'No household connection needed replacing.'));}catch(error){return res.redirect('/account/stremio?error='+encodeURIComponent(error.message));}});
  r.post('/account/stremio/revoke',mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await stremio.revoke(req.session.customerId);await installRecovery.clear(req.session.customerId);await managedEntitlements.revokeInactiveMappings();return res.redirect('/account/stremio?message='+encodeURIComponent('Stremio installation link revoked. Create a new link whenever you want to use Stremio again.'));}catch(error){return res.redirect('/account/stremio?error='+encodeURIComponent(error.message));}});
  return r;
}
module.exports={createCustomerStremioRouter,model,stremioDeepLink,preprovisionManaged,householdLabel};
