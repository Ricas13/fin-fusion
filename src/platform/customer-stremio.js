'use strict';

const express=require('express');
const {rateLimit,ipKeyGenerator}=require('express-rate-limit');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const operations=require('./operations-settings');
const runtimeSettings=require('./runtime-settings');
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
async function model(req,{credential=null,message=null,error=null}={}){
  await runtimeSettings.ensureLoaded();
  const sub=await provisioning.currentEntitlement(req.session.customerId),eligible=Boolean(sub&&['stremio','bundle'].includes(typeOf(sub))),row=await stremio.current(req.session.customerId);
  let effectiveCredential=credential;
  if(!effectiveCredential){const recovered=await installRecovery.current(req.session.customerId).catch(()=>null);effectiveCredential=recovered?.credential||null;}
  let manifestUrl=null,stremioUrl=null;
  if(effectiveCredential){manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(effectiveCredential)}/manifest.json`);stremioUrl=stremioDeepLink(manifestUrl);}
  const status=String(row?.status||'pending');
  return{siteName:runtimeSettings.siteName(),csrfToken:csrf.token(req),eligible,runtimeReady:foundation.runtimeReady(),status,statusLabel:row?status.replace(/^./,c=>c.toUpperCase()):'Not installed',accessModel:'1 Stremio household (IPv4 + IPv6)',tokenHint:row?.token_hint||null,credential:effectiveCredential,manifestUrl,stremioUrl,message,error};
}
async function preprovisionManaged(credential){
  try{const entitlement=await stremio.findByInstallToken(credential);if(entitlement)await managedEntitlements.ensure(entitlement);}catch(error){console.warn('Managed Stremio pre-provisioning deferred:',error.message);}
}
function createCustomerStremioRouter(){
  const r=express.Router();r.use('/account/stremio',guard);
  r.get('/account/stremio',async(req,res,next)=>{try{return res.render('customer/stremio',await model(req,{message:req.query.message||null,error:req.query.error||null}));}catch(e){next(e)}});
  r.post('/account/stremio/install',mutateLimit,async(req,res,next)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const issued=await stremio.issueInstallation(req.session.customerId);await installRecovery.save({customerId:req.session.customerId,entitlement:issued.entitlement,credential:issued.credential,actorUserId:req.session.customerUserId});await preprovisionManaged(issued.credential);return res.render('customer/stremio',await model(req,{credential:issued.credential,message:'Your Stremio installation credential has been rotated. Any previous addon URL is now invalid.'}));}catch(error){try{return res.status(400).render('customer/stremio',await model(req,{error:error.message}));}catch(e){next(e)}}});
  r.post('/account/stremio/reset-household',resetBurstLimit,mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const row=await stremio.current(req.session.customerId);if(!row||String(row.status||'')!=='active')throw new Error('No active Stremio household lease is available to reset.');const released=await householdAccess.release(row,{actorUserId:req.session.customerUserId,reason:'customer_reset'});return res.redirect('/account/stremio?message='+encodeURIComponent(released?'Household IP lease reset. The next Stremio playback will lease the current network.':'No active household IP lease needed resetting.'));}catch(error){return res.redirect('/account/stremio?error='+encodeURIComponent(error.message));}});
  r.post('/account/stremio/revoke',mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await stremio.revoke(req.session.customerId);await installRecovery.clear(req.session.customerId);await managedEntitlements.revokeInactiveMappings();return res.redirect('/account/stremio?message='+encodeURIComponent('Stremio installation revoked.'));}catch(error){return res.redirect('/account/stremio?error='+encodeURIComponent(error.message));}});
  return r;
}
module.exports={createCustomerStremioRouter,model,stremioDeepLink,preprovisionManaged};
