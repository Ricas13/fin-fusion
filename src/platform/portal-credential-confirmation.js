'use strict';

const express=require('express');
const bcrypt=require('bcryptjs');
const customers=require('../customers');
const customerSession=require('../auth/customer-session');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const emailChange=require('../security/customer-email-change');
const credentialCommands=require('../security/portal-credential-commands');
const emailSettings=require('../integrations/email-settings');
const emailOutbox=require('../integrations/email-outbox');
const {renderProfessionalEmail}=require('../integrations/email-template');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const branding=require('./branding');
const {esc}=require('./admin-html');

const {PASSWORD_TOKEN,EMAIL_OLD_TOKEN,EMAIL_NEW_TOKEN}=credentialCommands;
const credentialRequestLimit=routeRateLimit.middleware({scope:'portal-credential-request',max:10,windowSeconds:300,reason:'portal_credential_request'});
const credentialConfirmationLimit=routeRateLimit.middleware({scope:'portal-credential-confirmation',max:20,windowSeconds:300,reason:'portal_credential_confirmation'});

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/security'));}
function csrfGuard(req,res,next){return csrf.verify(req)?next():res.status(403).send('Invalid or expired security token');}
function onlyPost(req,res,next){return req.method==='POST'?next():next('router');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}

async function page(title,copy,action,token,button){
  await runtimeSettings.ensureLoaded();
  const site=runtimeSettings.siteName();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><link rel="stylesheet" href="/css/customer-portal.css"><link rel="stylesheet" href="/css/customer-navigation.css"></head><body><main style="max-width:720px;margin:auto;padding:32px 20px"><section class="panel"><h1>${esc(title)}</h1><p>${esc(copy)}</p><form method="post" action="${esc(action)}"><input type="hidden" name="_csrf" value="${esc(token.csrf)}"><input type="hidden" name="token" value="${esc(token.raw)}"><button class="button primary" type="submit">${esc(button)}</button></form></section></main></body></html>`;
}
async function resultPage(title,copy){
  await runtimeSettings.ensureLoaded();
  const site=runtimeSettings.siteName();
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(site)}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><link rel="stylesheet" href="/css/customer-portal.css"></head><body><main style="max-width:720px;margin:auto;padding:32px 20px"><section class="panel"><h1>${esc(title)}</h1><p>${esc(copy)}</p><p><a class="button primary" href="/account/login">Sign in</a></p></section></main></body></html>`;
}

async function requireMail(){const mail=await emailSettings.status();if(!mail.configured)throw new Error('Portal credential confirmation requires transactional email, but email is not configured.');}
async function baseUrl(){const cfg=await operations.get().catch(()=>operations.DEFAULTS);return String(cfg.publicBaseUrl||'').replace(/\/+$/,'');}
async function absolute(req,path){try{return await operations.absoluteUrl(req,path);}catch(_){const base=await baseUrl();if(!base)throw new Error('Public base URL is not configured.');return base+path;}}
async function absoluteFromConfiguredBase(path){const base=await baseUrl();if(!base)throw new Error('Public base URL is not configured.');return base+path;}
async function sendSecurityMail({to,subject,title,text,actionLabel,actionUrl,eventLabel='Account security',tone='warn',dedupeKey=null}){
  await runtimeSettings.ensureLoaded();
  const site=runtimeSettings.siteName(),publicBaseUrl=await baseUrl();
  await emailOutbox.enqueue({type:'portal_credential_confirmation',to,subject,text:`${text}\n\n${actionLabel}: ${actionUrl}`,html:renderProfessionalEmail({subject,title,text,eventLabel,tone,actionLabel,actionUrl,siteName:site,publicBaseUrl}),dedupeKey});
}
async function requestPasswordChange(req){
  if(req.body.newPassword!==req.body.confirmPassword)throw new Error('New passwords do not match.');
  await requireMail();
  const current=await emailChange.identity(req.session.customerId,req.session.customerUserId);
  if(!current.email_verified_at||!current.email)throw new Error('Your current portal email must be verified before you can change the portal password. Please contact support if you cannot access it.');
  await emailChange.assertPassword(req.session.customerUserId,req.body.currentPassword);
  await customers.validateNewPassword(req.body.newPassword);
  if(await bcrypt.compare(String(req.body.newPassword||''),current.password_hash))throw new Error('New password must be different from the current password.');
  const passwordHash=await bcrypt.hash(req.body.newPassword,12);
  const staged=await credentialCommands.stagePasswordChange({
    userId:req.session.customerUserId,
    customerId:req.session.customerId,
    expectedEmail:current.email,
    expectedPasswordHash:current.password_hash,
    passwordHash
  });
  const expiresAt=staged.expiresAt,raw=staged.raw;
  const url=await absolute(req,`/account/confirm-portal-password?token=${encodeURIComponent(raw)}`),site=runtimeSettings.siteName();
  await sendSecurityMail({to:staged.approvalEmail,subject:`Confirm your ${site} portal password change`,title:'Confirm portal password change',text:'A request was made to change your portal account password. The password will not change unless you approve this request from this verified email address.',actionLabel:'Approve password change',actionUrl:url,dedupeKey:`portal-password-change:${req.session.customerUserId}:${expiresAt.toISOString()}`});
  return {email:staged.approvalEmail,expiresAt};
}

async function completePasswordChange(raw){return credentialCommands.completePasswordChange(raw);}

async function requestEmailChange(req,current,nextEmail,displayName){
  await requireMail();
  if(!current.email_verified_at||!current.email)throw new Error('Your current portal email must be verified before you can change it. Please contact support if you cannot access it.');
  await emailChange.assertPassword(req.session.customerUserId,req.body.currentPassword);
  const name=String(displayName||'').trim().slice(0,100);if(!name)throw new Error('Display name is required.');
  const staged=await credentialCommands.stageEmailChange({
    userId:req.session.customerUserId,
    customerId:req.session.customerId,
    expectedOldEmail:current.email,
    nextEmail,
    displayName:name
  });
  const {raw,expiresAt,oldEmail}=staged;
  const url=await absolute(req,`/account/confirm-portal-email-old?token=${encodeURIComponent(raw)}`),site=runtimeSettings.siteName();
  await sendSecurityMail({to:oldEmail,subject:`Approve your ${site} email change`,title:'Approve portal email change',text:`A request was made to change your portal email to ${emailChange.maskEmail(nextEmail)}. Your current email remains in control until you approve this request.`,actionLabel:'Approve email change',actionUrl:url,dedupeKey:`portal-email-old:${req.session.customerUserId}:${expiresAt.toISOString()}`});
  return {oldEmail,nextEmail,expiresAt};
}

async function approveOldEmail(raw){
  const result=await credentialCommands.approveOldEmail(raw);
  if(!result)return null;
  await runtimeSettings.ensureLoaded();const site=runtimeSettings.siteName(),url=await absoluteFromConfiguredBase(`/account/confirm-portal-email-new?token=${encodeURIComponent(result.nextRaw)}`);
  await sendSecurityMail({to:result.nextEmail,subject:`Verify your new ${site} email address`,title:'Verify your new email address',text:'Your current verified email approved this change. Verify this new email address to complete the portal email change.',actionLabel:'Verify new email',actionUrl:url,eventLabel:'Email verification',tone:'info',dedupeKey:`portal-email-new:${result.userId}:${result.expiresAt.toISOString()}`});
  return result;
}

async function completeNewEmail(raw){
  const result=await credentialCommands.completeNewEmail(raw);
  if(result){const site=runtimeSettings.siteName(),base=await baseUrl(),securityUrl=base?`${base}/account/security`:'';sendSecurityMail({to:result.oldEmail,subject:`${site} email address changed`,title:'Portal email address changed',text:`Your portal email address was changed to ${emailChange.maskEmail(result.email)} after approval from the previous address and verification of the new address. All portal sessions were signed out. If this was not you, contact support immediately.`,actionLabel:securityUrl?'Review account security':'Contact support',actionUrl:securityUrl||'#',dedupeKey:null}).catch(()=>console.warn('Old-email completion notice failed'));}
  return result;
}

function createPortalCredentialConfirmationRouter(){
  const router=express.Router();router.use(['/account/confirm-portal-password','/account/confirm-portal-email-old','/account/confirm-portal-email-new'],noStore);
  // These are policy interceptors, not competing route owners. The existing
  // customer-security router remains the canonical owner of the POST paths.
  router.use('/account/security/password',onlyPost,requireCustomer,credentialRequestLimit,csrfGuard,async(req,res)=>{try{const change=await requestPasswordChange(req);return res.redirect('/account/security?message='+encodeURIComponent(`Confirmation sent to ${emailChange.maskEmail(change.email)}. Your portal password has not changed yet.`));}catch(error){return res.redirect('/account/security?error='+encodeURIComponent(String(error.message||'Password change could not be requested.')));}});
  router.use('/account/security/profile',onlyPost,requireCustomer,credentialRequestLimit,csrfGuard,async(req,res,next)=>{try{const current=await emailChange.identity(req.session.customerId,req.session.customerUserId),nextEmail=emailChange.cleanEmail(req.body.email);if(String(current.email||'').toLowerCase()===nextEmail)return next('router');if(!String(req.body.currentPassword||''))return next('router');const change=await requestEmailChange(req,current,nextEmail,req.body.displayName);return res.redirect('/account/security?message='+encodeURIComponent(`Approval sent to your current verified email (${emailChange.maskEmail(change.oldEmail)}). The new email is not active yet.`));}catch(error){return res.redirect('/account/security?error='+encodeURIComponent(String(error.message||'Email change could not be requested.')));}});
  router.get('/account/confirm-portal-password',async(req,res)=>{const raw=String(req.query.token||'');if(!raw)return res.status(400).send(await resultPage('Invalid link','This password-change confirmation link is incomplete.'));return res.send(await page('Confirm portal password change','Approve this request to replace your portal password and sign out every existing portal session.','/account/confirm-portal-password',{raw,csrf:csrf.token(req)},'Approve password change'));});
  router.post('/account/confirm-portal-password',credentialConfirmationLimit,csrfGuard,async(req,res)=>{const done=await completePasswordChange(req.body.token).catch(()=>null);if(!done)return res.status(400).send(await resultPage('Password not changed','This confirmation link is invalid, expired, already used, or the account security details changed after the request was created.'));await customerSession.destroy(req).catch(()=>{});return res.send(await resultPage('Portal password changed',`Your portal password was changed and ${done.revoked} portal session(s) were signed out.`));});
  router.get('/account/confirm-portal-email-old',async(req,res)=>{const raw=String(req.query.token||'');if(!raw)return res.status(400).send(await resultPage('Invalid link','This email-change approval link is incomplete.'));return res.send(await page('Approve portal email change','Approve the request from your current verified email. The new address will still have to be verified before it becomes active.','/account/confirm-portal-email-old',{raw,csrf:csrf.token(req)},'Approve and send new-email verification'));});
  router.post('/account/confirm-portal-email-old',credentialConfirmationLimit,csrfGuard,async(req,res)=>{try{const approved=await approveOldEmail(req.body.token);if(!approved)return res.status(400).send(await resultPage('Email not changed','This approval link is invalid, expired or already used.'));return res.send(await resultPage('Current email approved','Approval succeeded. A separate verification message has been sent to the new email address. Your current email remains active until that verification is completed.'));}catch(error){return res.status(400).send(await resultPage('Email approval failed',String(error.message||'The email change could not be approved.')));}});
  router.get('/account/confirm-portal-email-new',async(req,res)=>{const raw=String(req.query.token||'');if(!raw)return res.status(400).send(await resultPage('Invalid link','This new-email verification link is incomplete.'));return res.send(await page('Verify new portal email','Verify ownership of this new email address to complete the portal email change. All portal sessions will be signed out.','/account/confirm-portal-email-new',{raw,csrf:csrf.token(req)},'Verify and change email'));});
  router.post('/account/confirm-portal-email-new',credentialConfirmationLimit,csrfGuard,async(req,res)=>{try{const done=await completeNewEmail(req.body.token);if(!done)return res.status(400).send(await resultPage('Email not changed','This verification link is invalid, expired, already used, or the pending change no longer matches the account.'));await customerSession.destroy(req).catch(()=>{});return res.send(await resultPage('Portal email changed',`Your new portal email is verified and active. ${done.revoked} portal session(s) were signed out.`));}catch(error){return res.status(400).send(await resultPage('Email verification failed',String(error.message||'The email change could not be completed.')));}});
  return router;
}

module.exports={createPortalCredentialConfirmationRouter,requestPasswordChange,completePasswordChange,requestEmailChange,approveOldEmail,completeNewEmail,PASSWORD_TOKEN,EMAIL_OLD_TOKEN,EMAIL_NEW_TOKEN};
