'use strict';
const express=require('express');
const crypto=require('crypto');
const customers=require('../customers');
const customerSession=require('../auth/customer-session');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const publicError=require('./public-error');
const customerNav=require('./customer-nav-html');
const emailSettings=require('../integrations/email-settings');
const emailOutbox=require('../integrations/email-outbox');
const emailChange=require('../security/customer-email-change');
const twoFactor=require('../security/customer-two-factor');
const customerRateLimit=require('../security/customer-rate-limit');
const csrf=require('../auth/csrf');
const save=customerSession.save;
const regenerate=customerSession.regenerate;
const destroy=customerSession.destroy;
const establish=customerSession.establish;
function safeNext(value){const next=String(value||'');return next.startsWith('/')&&!next.startsWith('//')?next:'/account'}
function esc(v){return String(v==null?'':v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'))}
function normalizeLoginIdentity(value){return String(value||'').trim().toLowerCase().slice(0,254)}
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
function accountTransitionPage(site,title,body,navHtml=''){return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(site)}</title><link rel="stylesheet" href="/css/customer-portal.css"><link rel="stylesheet" href="/css/customer-navigation.css"><style>.securityMain{max-width:1050px;margin:auto;padding:24px}.panel{padding:20px}.field{margin:14px 0}</style></head><body><main class="securityMain">${navHtml}<div class="customerPortalPageHeader"><div><h1>${esc(title)}</h1></div></div>${body}</main></body></html>`;}
async function accountNavHtml(req){return customerNav.nav('account',await customerNav.optionsForCustomer(req.session.customerId));}
function confirmationPage(req,{displayName,email,error=null},navHtml=''){const site=runtimeSettings.siteName();return accountTransitionPage(site,'Confirm email change',`<section class="panel"><p>Changing the account email also changes where password-reset messages are delivered. Enter your current portal password to approve the change to <strong>${esc(email)}</strong>.</p>${error?`<div class="notice error">${esc(error)}</div>`:''}<form method="post" action="/account/security/profile"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><input type="hidden" name="displayName" value="${esc(displayName)}"><input type="hidden" name="email" value="${esc(email)}"><div class="field"><label>Current portal password</label><input class="input" type="password" name="currentPassword" autocomplete="current-password" required autofocus></div><button class="button primary">Confirm email change</button></form></section>`,navHtml);}
function twoFactorPasswordPage(req,error=null,navHtml=''){const site=runtimeSettings.siteName();return accountTransitionPage(site,'Confirm two-factor setup',`<section class="panel"><p>Enter your current portal password before adding a new authenticator. This prevents a stolen browser session from installing an attacker-controlled second factor.</p>${error?`<div class="notice error">${esc(error)}</div>`:''}<form method="post" action="/account/security/2fa/start"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="field"><label>Current portal password</label><input class="input" type="password" name="currentPassword" autocomplete="current-password" required autofocus></div><button class="button primary">Continue to authenticator setup</button></form></section>`,navHtml);}
async function processProfile(req,res){try{await runtimeSettings.ensureLoaded();const current=await emailChange.identity(req.session.customerId,req.session.customerUserId),displayName=String(req.body.displayName||'').trim(),email=emailChange.cleanEmail(req.body.email),changed=String(current.email||'').toLowerCase()!==email;if(changed&&!String(req.body.currentPassword||''))return res.status(200).send(confirmationPage(req,{displayName,email},await accountNavHtml(req)));const requireVerification=runtimeSettings.requireEmailVerification();if(changed&&requireVerification){const mail=await emailSettings.status();if(!mail.configured)throw new Error('Email verification is required, but transactional email is not configured.');}const out=await emailChange.begin({customerId:req.session.customerId,userId:req.session.customerUserId,displayName,email,currentPassword:req.body.currentPassword,requireVerification,currentSessionId:req.sessionID});if(!out.changed)return res.redirect('/account/security?message='+encodeURIComponent('Profile updated.'));if(out.pending){const site=runtimeSettings.siteName(),url=await operations.absoluteUrl(req,`/account/verify-email-change?token=${encodeURIComponent(out.token)}`);await emailOutbox.enqueue({type:'email_change_verification',to:out.email,subject:`Confirm your ${site} email change`,text:`Confirm that this should become the email address for your ${site} account: ${url}\n\nThis link expires in 24 hours. If you did not request this change, do not use the link.`,html:`<p>Confirm that <strong>${esc(out.email)}</strong> should become the email address for your ${esc(site)} account.</p><p><a href="${esc(url)}">Confirm email change</a></p><p>This link expires in 24 hours. If you did not request this change, ignore this message.</p>`,dedupeKey:`email-change:${req.session.customerUserId}:${out.expiresAt.toISOString()}`});return res.redirect('/account/security?message='+encodeURIComponent(`Profile saved. Check ${out.email} to confirm the email change; your current email remains authoritative until then.`));}if(out.sessionVersion){req.session.customerSessionVersion=out.sessionVersion;await save(req);}return res.redirect('/account/security?message='+encodeURIComponent(`Email changed. ${out.revokedSessions||0} other session(s) were signed out.`));}catch(error){const failure=publicError.present(error,{context:'Customer profile update failed',fallback:'Profile could not be updated right now. Please try again later.'}),displayName=String(req.body.displayName||'').trim(),email=String(req.body.email||'').trim();if(String(req.body.currentPassword||''))return res.status(failure.status).send(confirmationPage(req,{displayName,email,error:failure.message},await accountNavHtml(req)));return res.redirect('/account/security?error='+encodeURIComponent(failure.message));}}
function createCustomerLoginRouter(){const r=express.Router();
 r.get('/account/login',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const message=req.query.locked?'Too many incorrect two-factor codes. This account is temporarily locked; try again later.':req.query.session==='expired'?'Your session expired. Sign in again.':null;return res.render('customer/login',{error:null,message,next:safeNext(req.query.next),csrfToken:csrf.token(req),siteName:runtimeSettings.siteName()})}catch(e){next(e)}});
 // Identity throttling runs after the router-level Turnstile gate and before
 // password verification, closing the distributed-IP credential-stuffing gap.
 r.use('/account/login',identityLoginRateLimit);
 // Hardened login interception. Middleware avoids registering a second route
 // owner while still running before the compatibility security router.
 r.use('/account/login',async(req,res,next)=>{if(req.method!=='POST')return next();if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');try{const account=await customers.authenticateCustomer(req.body.identity,req.body.password);if(!account)throw new Error('Invalid email/username or password');const lock=await twoFactor.locked(account.userId);if(lock.locked)throw new Error('This account is temporarily locked after repeated security-code failures. Try again later.');const state=await twoFactor.state(account.userId);if(state?.totp_enabled){await regenerate(req);req.session.pendingCustomerAuth={account,startedAt:Date.now(),next:safeNext(req.body.next)};req.session.csrfToken=crypto.randomBytes(32).toString('base64url');req.session.cookie.maxAge=10*60*1000;await save(req);return res.redirect('/account/2fa');}await establish(req,account);return res.redirect(safeNext(req.body.next));}catch(error){await runtimeSettings.ensureLoaded();const failure=publicError.present(error,{context:'Customer login failed',fallback:'Authentication temporarily unavailable. Please try again later.',status:401});return res.status(failure.status).render('customer/login',{error:failure.message,message:null,next:safeNext(req.body.next),csrfToken:csrf.token(req),siteName:runtimeSettings.siteName()});}});
 // Persistent challenge accounting. Recovery codes remain one-use and a valid
 // TOTP/recovery code clears the account-level backoff. Again this is middleware
 // so the assembled application has one explicit POST owner for the path.
 r.use('/account/2fa',async(req,res,next)=>{if(req.method!=='POST')return next();if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');const pending=req.session?.pendingCustomerAuth;if(!pending||Date.now()-Number(pending.startedAt||0)>10*60*1000){await destroy(req);return res.redirect('/account/login?session=expired');}const result=await twoFactor.verify(pending.account.userId,req.body.code);if(!result.ok){if(result.locked){await destroy(req);return res.redirect('/account/login?locked=1');}await save(req);return res.redirect('/account/2fa?error=1');}const destination=pending.next,account=pending.account;await establish(req,account);return res.redirect(safeNext(destination));});
 // Security-sensitive profile/email change interception. The historical route
 // remains the single route owner, but this middleware performs the hardened
 // staged-email workflow before that legacy handler can run.
 r.use('/account/security/profile',(req,res,next)=>{if(req.method!=='POST')return next();return requireCustomer(req,res,()=>{if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');processProfile(req,res).catch(next);});});
 // Require the current password before the existing enrollment route begins.
 r.use('/account/security/2fa/start',(req,res,next)=>{if(req.method!=='POST')return next();return requireCustomer(req,res,async()=>{if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');try{if(!String(req.body.currentPassword||''))return res.status(200).send(twoFactorPasswordPage(req,null,await accountNavHtml(req)));await emailChange.assertPassword(req.session.customerUserId,req.body.currentPassword);return next();}catch(error){const failure=publicError.present(error,{context:'Customer 2FA password confirmation failed',fallback:'Two-factor setup could not be started right now. Please try again later.'});return res.status(failure.status).send(twoFactorPasswordPage(req,failure.message,await accountNavHtml(req)));}});});
 r.post('/account/password',requireCustomer,(req,res)=>res.redirect('/account/security?error='+encodeURIComponent('Use Account Security to change your portal password; your current password is required.')));
 return r}
module.exports={createCustomerLoginRouter,safeNext,processProfile,confirmationPage,twoFactorPasswordPage,accountTransitionPage,accountNavHtml,establish,normalizeLoginIdentity,identityLoginRateLimit};
