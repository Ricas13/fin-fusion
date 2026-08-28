'use strict';
const express=require('express');
const crypto=require('crypto');
const {query}=require('../db');
const customers=require('../customers');
const customerSession=require('../auth/customer-session');
const runtimeSettings=require('./runtime-settings');
const publicError=require('./public-error');
const twoFactor=require('../security/customer-two-factor');
const customerRateLimit=require('../security/customer-rate-limit');
const csrf=require('../auth/csrf');
const save=customerSession.save;
const regenerate=customerSession.regenerate;
const destroy=customerSession.destroy;
const establish=customerSession.establish;
function safeNext(value){const next=String(value||'');return next.startsWith('/')&&!next.startsWith('//')?next:'/account'}
function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'))}
function normalizeLoginIdentity(value){return String(value||'').trim().toLowerCase().slice(0,254)}
async function recordCompletedLogin(account,twoFactorUsed=false){
 try{await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.login.success','customer',$2,$3::jsonb)`,[account.userId,account.customerId,JSON.stringify({username:String(account.username||'').slice(0,80),twoFactorUsed:Boolean(twoFactorUsed)})]);}
 catch(error){console.warn('Customer login activity audit failed:',error.message)}
}
async function identityLoginRateLimit(req,res,next){
 if(req.method!=='POST')return next();
 const identity=normalizeLoginIdentity(req.body?.identity);
 if(!identity)return next();
 try{
  // This middleware is mounted inside createRouter(), after the global Turnstile
  // middleware. A distributed attacker therefore has to pass Cloudflare before
  // consuming a pseudonymous account/identity bucket. The persisted bucket key
  // is HMACed by customer-rate-limit.js; raw email/usernames never enter the DB.
  const result=await customerRateLimit.consume(`customer-login-identity:${identity}`,{limit:30,windowMs:15*60*1000});
  if(!result.allowed){
   res.setHeader('Retry-After',String(Math.max(1,Math.ceil((result.resetAt.getTime()-Date.now())/1000))));
   return res.status(429).send('Too many login attempts. Try again later.');
  }
  return next();
 }catch(error){
  console.error('Customer identity login limiter unavailable:',error.message);
  return res.status(503).send('Authentication temporarily unavailable.');
 }
}
function createCustomerLoginRouter(){const r=express.Router();
 r.get('/account/login',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const message=req.query.locked?'Too many incorrect two-factor codes. This account is temporarily locked; try again later.':req.query.session==='expired'?'Your session expired. Sign in again.':null;return res.render('customer/login',{error:null,message,next:safeNext(req.query.next),csrfToken:csrf.token(req),siteName:runtimeSettings.siteName()})}catch(e){next(e)}});
 // Identity throttling runs after the router-level Turnstile gate and before
 // password verification, closing the distributed-IP credential-stuffing gap.
 r.use('/account/login',identityLoginRateLimit);
 r.post('/account/login',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');try{const account=await customers.authenticateCustomer(req.body.identity,req.body.password);if(!account)throw new Error('Invalid email/username or password');const lock=await twoFactor.locked(account.userId);if(lock.locked)throw new Error('This account is temporarily locked after repeated security-code failures. Try again later.');const state=await twoFactor.state(account.userId);if(state?.totp_enabled){await regenerate(req);req.session.pendingCustomerAuth={account,startedAt:Date.now(),next:safeNext(req.body.next)};req.session.csrfToken=crypto.randomBytes(32).toString('base64url');req.session.cookie.maxAge=10*60*1000;await save(req);return res.redirect('/account/2fa');}await establish(req,account);await recordCompletedLogin(account,false);return res.redirect(safeNext(req.body.next));}catch(error){await runtimeSettings.ensureLoaded();const failure=publicError.present(error,{context:'Customer login failed',fallback:'Authentication temporarily unavailable. Please try again later.',status:401});return res.status(failure.status).render('customer/login',{error:failure.message,message:null,next:safeNext(req.body.next),csrfToken:csrf.token(req),siteName:runtimeSettings.siteName()});}});
 r.post('/account/2fa',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');const pending=req.session?.pendingCustomerAuth;if(!pending||Date.now()-Number(pending.startedAt||0)>10*60*1000){await destroy(req);return res.redirect('/account/login?session=expired');}const result=await twoFactor.verify(pending.account.userId,req.body.code);if(!result.ok){if(result.locked){await destroy(req);return res.redirect('/account/login?locked=1');}await save(req);return res.redirect('/account/2fa?error=1');}const destination=pending.next,account=pending.account;await establish(req,account);await recordCompletedLogin(account,true);return res.redirect(safeNext(destination));});
 r.post('/account/password',requireCustomer,(req,res)=>res.redirect('/account/security?error='+encodeURIComponent('Use Account Security to change your portal password; your current password is required.')));
 return r}
module.exports={createCustomerLoginRouter,safeNext,establish,normalizeLoginIdentity,identityLoginRateLimit,recordCompletedLogin};
