'use strict';

const express=require('express');
const {rateLimit,ipKeyGenerator}=require('express-rate-limit');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const stremio=require('../stremio/entitlements');
const managedEntitlements=require('../stremio/managed-entitlements');
const managedSources=require('../stremio/managed-sources');
const installRecovery=require('../stremio/install-credential-recovery');
const householdAccess=require('../stremio/household-access');

const mutateLimit=routeRateLimit.middleware({scope:'customer-stremio-install',max:10,windowSeconds:300});
const resetBurstLimit=rateLimit({windowMs:300_000,limit:10,keyGenerator:req=>req.session?.customerUserId?`customer:${req.session.customerUserId}`:ipKeyGenerator(req.ip),standardHeaders:false,legacyHeaders:false});
function guard(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account#stremio-access'));}
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
function homeRedirect(kind,message){return `/account?${kind}=${encodeURIComponent(message)}#stremio-access`;}
function createCustomerStremioRouter(){
  const r=express.Router();r.use('/account/stremio',guard);
  // Compatibility URL: Stremio setup now lives directly on Account Home.
  r.get('/account/stremio',(req,res)=>res.redirect(302,'/account#stremio-access'));
  r.post('/account/stremio/install',mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const issued=await stremio.issueInstallation(req.session.customerId);await installRecovery.save({customerId:req.session.customerId,entitlement:issued.entitlement,credential:issued.credential,actorUserId:req.session.customerUserId});const provisioned=await preprovisionManaged(issued.credential);return res.redirect(homeRedirect(provisioned?'message':'error',provisioned?'Your new Stremio installation link is ready. This is a secret bearer link: anyone who has it can use your Stremio access, so treat it like a password and do not share it. Any previous installation link has been replaced.':'Your new Stremio installation link is ready, but automatic access setup is still finishing. Treat the link like a password and do not share it. If playback does not work within a few minutes, open Account Home and create the link again.'));}catch(error){return res.redirect(homeRedirect('error',error.message||'Stremio installation link could not be created.'));}});
  r.post('/account/stremio/reset-household',resetBurstLimit,mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const row=await stremio.current(req.session.customerId);if(!row||String(row.status||'')!=='active')throw new Error('No active household connection is available to replace.');const released=await householdAccess.release(row,{actorUserId:req.session.customerUserId,reason:'customer_reset',customerInitiated:true});return res.redirect(homeRedirect('message',released?'Household connection released. Your next Stremio playback will register the internet connection you are using now.':'No household connection needed replacing.'));}catch(error){return res.redirect(homeRedirect('error',error.message));}});
  r.post('/account/stremio/revoke',mutateLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await stremio.revoke(req.session.customerId);await installRecovery.clear(req.session.customerId);await managedEntitlements.revokeInactiveMappings();return res.redirect(homeRedirect('message','Stremio installation link revoked. Create a new link whenever you want to use Stremio again.'));}catch(error){return res.redirect(homeRedirect('error',error.message));}});
  return r;
}
module.exports={createCustomerStremioRouter};