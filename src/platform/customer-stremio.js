'use strict';

const express=require('express');
const {rateLimit,ipKeyGenerator}=require('express-rate-limit');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const stremio=require('../stremio/entitlements');
const managedEntitlements=require('../stremio/managed-entitlements');
const managedSources=require('../stremio/managed-sources');
const householdAccess=require('../stremio/household-access');
const installationLinks=require('../stremio/customer-installation-links');

const accessLimit=routeRateLimit.middleware({scope:'customer-stremio-access',max:120,windowSeconds:60});
const mutateLimit=routeRateLimit.middleware({scope:'customer-stremio-install',max:10,windowSeconds:300});
// Keep the distributed route limiter above, and also bind an explicit
// express-rate-limit guard to each authorization-bearing mutation. Besides
// providing a local fail-safe, this makes the rate-limit boundary visible to
// static security analysis instead of relying on prefix middleware inference.
const mutationBurstLimit=rateLimit({windowMs:300_000,limit:10,keyGenerator:req=>req.session?.customerUserId?`customer:${req.session.customerUserId}`:ipKeyGenerator(req.ip),standardHeaders:false,legacyHeaders:false});
function guard(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/access#stremio-access'));}
async function preprovisionManaged(credential){
  try{
    const entitlement=await stremio.findByInstallToken(credential);
    if(!entitlement)return true;
    const sources=await managedSources.enabled();
    if(!sources.length)return true;
    const ready=await managedEntitlements.ensure(entitlement);
    return ready.length>=sources.length;
  }catch(error){
    console.warn('Managed Stremio pre-provisioning deferred:',error.message);
    return false;
  }
}
async function issueCustomerInstallation(customerId,{actorUserId=null}={}){
  const issued=await stremio.issueInstallation(customerId,{actorUserId});
  const provisioned=await preprovisionManaged(issued.credential);
  return{issued,provisioned};
}
async function customerSetupState(req,customerId){
  const links=await installationLinks.current(req,customerId);
  const entitlement=await stremio.current(customerId).catch(()=>null);
  if(!entitlement)return{...links,household:null};
  try{
    const configured=await householdAccess.configForEntitlement(entitlement);
    const limit=Math.max(1,Number(configured?.component?.config?.networkLimit||1));
    const status=String(entitlement.status||'pending');
    const replacement=status==='active'?await householdAccess.replacementState(entitlement):null;
    return{
      ...links,
      household:{
        status,
        accessModel:`Unlimited streams · Unlimited devices · ${limit} household connection${limit===1?'':'s'}`,
        replacementState:replacement?{
          allowed:Boolean(replacement.allowed),
          message:replacement.allowed?'You can change the registered household connection now.':householdAccess.cooldownMessage(replacement)
        }:null
      }
    };
  }catch(error){
    console.warn('Customer Stremio household status unavailable:',{customerId,error:error.message});
    return{...links,household:{status:String(entitlement.status||'pending'),accessModel:'Unlimited streams · Unlimited devices · 1 household connection',replacementState:null}};
  }
}
function accessRedirect(kind,message){return `/account/access?${kind}=${encodeURIComponent(message)}#stremio-access`;}
function homeRedirect(kind,message){return accessRedirect(kind,message);}
function requestRedirect(req,kind,message){return req.body?.returnTo==='access'?accessRedirect(kind,message):homeRedirect(kind,message);}
function createCustomerStremioRouter(){
  const r=express.Router();r.use('/account/stremio',accessLimit,guard);
  // Preserve the legacy compatibility URL while the customer-facing setup now lives on My Access.
  r.get('/account/stremio',(req,res)=>res.redirect(302,'/account#stremio-access'));
  r.get('/account/stremio/installation.json',async(req,res)=>{try{res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');return res.json(await customerSetupState(req,req.session.customerId));}catch(error){console.warn('Customer Stremio installation lookup failed:',{customerId:req.session.customerId,error:error.message});return res.status(503).json({manifestUrl:null,installUrl:null,household:null,error:'Stremio installation link is temporarily unavailable.'});}});
  r.post('/account/stremio/install',mutateLimit,mutationBurstLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const{provisioned}=await issueCustomerInstallation(req.session.customerId,{actorUserId:req.session.customerUserId});const message=provisioned?'Your new Stremio installation link is ready. This is a secret bearer link: anyone who has it can use your Stremio access, so treat it like a password and do not share it. Any previous installation link has been replaced.':'Your new Stremio installation link is ready, but automatic access setup is still finishing. Treat the link like a password and do not share it. If playback does not work within a few minutes, retry Stremio setup.';const target=req.body?.returnTo==='access'?accessRedirect(provisioned?'message':'error',message):homeRedirect(provisioned ? 'message' : 'error',message);return res.redirect(target);}catch(error){return res.redirect(requestRedirect(req,'error',error.message||'Stremio installation link could not be created.'));}});
  r.post('/account/stremio/reset-household',mutationBurstLimit,mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const row=await stremio.current(req.session.customerId);if(!row||String(row.status||'')!=='active')throw new Error('No active household connection is available to replace.');const released=await householdAccess.release(row,{actorUserId:req.session.customerUserId,reason:'customer_reset',customerInitiated:true});return res.redirect(requestRedirect(req,'message',released?'Household connection released. Your next Stremio playback will register the internet connection you are using now.':'No household connection needed replacing.'));}catch(error){return res.redirect(requestRedirect(req,'error',error.message));}});
  r.post('/account/stremio/revoke',mutateLimit,mutationBurstLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await stremio.revoke(req.session.customerId);await managedEntitlements.revokeInactiveMappings();return res.redirect(requestRedirect(req,'message','Stremio installation link revoked. Create a new link whenever you want to use Stremio again.'));}catch(error){return res.redirect(requestRedirect(req,'error',error.message));}});
  return r;
}
module.exports={createCustomerStremioRouter,issueCustomerInstallation,customerSetupState};
