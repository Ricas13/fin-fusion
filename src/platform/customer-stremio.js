'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const operations=require('./operations-settings');
const runtimeSettings=require('./runtime-settings');
const provisioning=require('../jellyfin/provisioning');
const foundation=require('../stremio/foundation');
const stremio=require('../stremio/entitlements');

const mutateLimit=routeRateLimit.middleware({scope:'customer-stremio-install',max:10,windowSeconds:300});
function guard(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/stremio'));}
function typeOf(row){return String(row?.service_type_snapshot||row?.service_type||'jellyfin');}
function stremioDeepLink(manifestUrl){const url=new URL(manifestUrl);return `stremio://${url.host}${url.pathname}${url.search}`;}
async function model(req,{credential=null,message=null,error=null}={}){
  await runtimeSettings.ensureLoaded();
  const sub=await provisioning.currentEntitlement(req.session.customerId),eligible=Boolean(sub&&['stremio','bundle'].includes(typeOf(sub))),row=await stremio.current(req.session.customerId);
  let manifestUrl=null,stremioUrl=null;
  if(credential){manifestUrl=await operations.absoluteUrl(req,`/stremio/${encodeURIComponent(credential)}/manifest.json`);stremioUrl=stremioDeepLink(manifestUrl);}
  const status=String(row?.status||'pending');
  return{siteName:runtimeSettings.siteName(),csrfToken:csrf.token(req),eligible,runtimeReady:foundation.runtimeReady(),status,statusLabel:row?status.replace(/^./,c=>c.toUpperCase()):'Not installed',streamLimit:Number(row?.stream_limit||sub?.streams||1),tokenHint:row?.token_hint||null,credential,manifestUrl,stremioUrl,message,error};
}
function createCustomerStremioRouter(){
  const r=express.Router();r.use('/account/stremio',guard);
  r.get('/account/stremio',async(req,res,next)=>{try{return res.render('customer/stremio',await model(req,{message:req.query.message||null,error:req.query.error||null}));}catch(e){next(e)}});
  r.post('/account/stremio/install',mutateLimit,async(req,res,next)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const issued=await stremio.issueInstallation(req.session.customerId);return res.render('customer/stremio',await model(req,{credential:issued.credential,message:'Your Stremio installation credential has been rotated. Any previous addon URL is now invalid.'}));}catch(error){try{return res.status(400).render('customer/stremio',await model(req,{error:error.message}));}catch(e){next(e)}}});
  r.post('/account/stremio/revoke',mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await stremio.revoke(req.session.customerId);return res.redirect('/account/stremio?message='+encodeURIComponent('Stremio installation revoked.'));}catch(error){return res.redirect('/account/stremio?error='+encodeURIComponent(error.message));}});
  return r;
}
module.exports={createCustomerStremioRouter,model,stremioDeepLink};
