'use strict';

const express=require('express');
const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const customers=require('../customers');
const customerSession=require('../auth/customer-session');
const csrf=require('../auth/csrf');
const {transaction}=require('../db');
const emailChange=require('../security/customer-email-change');
const emailSettings=require('../integrations/email-settings');
const emailOutbox=require('../integrations/email-outbox');
const {renderProfessionalEmail}=require('../integrations/email-template');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const branding=require('./branding');
const {esc}=require('./admin-html');

const PASSWORD_TOKEN='portal_password_change';
const EMAIL_OLD_TOKEN='portal_email_old_approval';
const EMAIL_NEW_TOKEN='portal_email_new_verification';
const PASSWORD_TTL_MINUTES=30;
const EMAIL_TTL_MINUTES=24*60;

function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account/security'));}
function csrfGuard(req,res,next){return csrf.verify(req)?next():res.status(403).send('Invalid or expired security token');}
function onlyPost(req,res,next){return req.method==='POST'?next():next('router');}
function tokenHash(raw){return crypto.createHash('sha256').update(String(raw||''),'utf8').digest('hex');}
function passwordDigest(hash){return crypto.createHash('sha256').update(String(hash||''),'utf8').digest('hex');}
function expiry(minutes){return new Date(Date.now()+minutes*60000);}
function rawToken(){return crypto.randomBytes(32).toString('base64url');}
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
async function revokeAllSessions(client,userId){
  const sessions=await client.query(`SELECT session_id FROM auth_sessions WHERE user_id=$1 AND role='customer'`,[userId]),ids=sessions.rows.map(row=>row.session_id);
  await client.query(`UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND role='customer'`,[userId]);
  if(ids.length)await client.query(`DELETE FROM user_sessions WHERE sid=ANY($1::text[])`,[ids]);
  return ids.length;
}
async function tokenForUpdate(client,raw,type){const found=await client.query(`SELECT * FROM account_tokens WHERE token_hash=$1 AND token_type=$2 AND consumed_at IS NULL AND expires_at>NOW() FOR UPDATE`,[tokenHash(raw),type]);return found.rows[0]||null;}
async function invalidate(client,userId,types){await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE user_id=$1 AND token_type=ANY($2::text[]) AND consumed_at IS NULL`,[userId,types]);}

async function requestPasswordChange(req){
  if(req.body.newPassword!==req.body.confirmPassword)throw new Error('New passwords do not match.');
  await requireMail();
  const current=await emailChange.identity(req.session.customerId,req.session.customerUserId);
  if(!current.email_verified_at||!current.email)throw new Error('Your current portal email must be verified before you can change the portal password. Please contact support if you cannot access it.');
  await emailChange.assertPassword(req.session.customerUserId,req.body.currentPassword);
  await customers.validateNewPassword(req.body.newPassword);
  if(await bcrypt.compare(String(req.body.newPassword||''),current.password_hash))throw new Error('New password must be different from the current password.');
  const passwordHash=await bcrypt.hash(req.body.newPassword,12),raw=rawToken(),expiresAt=expiry(PASSWORD_TTL_MINUTES);
  const staged=await transaction(async client=>{
    const locked=(await client.query(`SELECT email,email_verified_at,password_hash FROM app_users WHERE id=$1 AND role='customer' FOR UPDATE`,[req.session.customerUserId])).rows[0];
    if(!locked||!locked.email_verified_at||!locked.email||String(locked.email).toLowerCase()!==String(current.email).toLowerCase()||locked.password_hash!==current.password_hash)throw new Error('Your account security details changed while this request was being created. Please try again.');
    await invalidate(client,req.session.customerUserId,[PASSWORD_TOKEN]);
    const approvalEmail=String(locked.email).toLowerCase();
    await client.query(`INSERT INTO account_tokens(user_id,token_type,token_hash,expires_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,[req.session.customerUserId,PASSWORD_TOKEN,tokenHash(raw),expiresAt,JSON.stringify({passwordHash,basePasswordDigest:passwordDigest(locked.password_hash),approvalEmail,customerId:req.session.customerId})]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1::uuid,'customer.password_change.request','app_user',$1::text,$2::jsonb)`,[req.session.customerUserId,JSON.stringify({confirmation:'verified_email',approvalEmail,expiresAt})]);
    return {approvalEmail};
  });
  const url=await absolute(req,`/account/confirm-portal-password?token=${encodeURIComponent(raw)}`),site=runtimeSettings.siteName();
  await sendSecurityMail({to:staged.approvalEmail,subject:`Confirm your ${site} portal password change`,title:'Confirm portal password change',text:'A request was made to change your portal account password. The password will not change unless you approve this request from this verified email address.',actionLabel:'Approve password change',actionUrl:url,dedupeKey:`portal-password-change:${req.session.customerUserId}:${expiresAt.toISOString()}`});
  return {email:staged.approvalEmail,expiresAt};
}

async function completePasswordChange(raw){
  return transaction(async client=>{
    const token=await tokenForUpdate(client,raw,PASSWORD_TOKEN);if(!token)return null;
    const user=(await client.query(`SELECT password_hash,email,email_verified_at FROM app_users WHERE id=$1 AND role='customer' FOR UPDATE`,[token.user_id])).rows[0];if(!user)return null;
    const approvalEmail=String(token.metadata?.approvalEmail||'').toLowerCase();
    if(!user.email_verified_at||!approvalEmail||String(user.email||'').toLowerCase()!==approvalEmail||passwordDigest(user.password_hash)!==String(token.metadata?.basePasswordDigest||'')){await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);return null;}
    const passwordHash=String(token.metadata?.passwordHash||'');if(!passwordHash.startsWith('$2')){await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);return null;}
    const updated=await client.query(`UPDATE app_users SET password_hash=$2,password_changed_at=NOW(),session_version=session_version+1,updated_at=NOW() WHERE id=$1 RETURNING session_version`,[token.user_id,passwordHash]);
    const revoked=await revokeAllSessions(client,token.user_id);
    await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1::uuid,'customer.password.change','app_user',$1::text,$2::jsonb)`,[token.user_id,JSON.stringify({confirmation:'verified_email',approvalEmail,revokedSessions:revoked,sessionVersion:Number(updated.rows[0].session_version)})]);
    return {userId:token.user_id,revoked};
  });
}

async function requestEmailChange(req,current,nextEmail,displayName){
  await requireMail();
  if(!current.email_verified_at||!current.email)throw new Error('Your current portal email must be verified before you can change it. Please contact support if you cannot access it.');
  await emailChange.assertPassword(req.session.customerUserId,req.body.currentPassword);
  const name=String(displayName||'').trim().slice(0,100);if(!name)throw new Error('Display name is required.');
  const raw=rawToken(),expiresAt=expiry(EMAIL_TTL_MINUTES),oldEmail=String(current.email).toLowerCase();
  await transaction(async client=>{
    const locked=(await client.query(`SELECT email,email_verified_at FROM app_users WHERE id=$1 AND role='customer' FOR UPDATE`,[req.session.customerUserId])).rows[0];
    if(!locked||!locked.email_verified_at||String(locked.email||'').toLowerCase()!==oldEmail)throw new Error('Your account email changed while this request was being created. Please try again.');
    const duplicate=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,[nextEmail,req.session.customerUserId]);if(duplicate.rowCount)throw new Error('That email address is already in use.');
    await client.query(`UPDATE customers SET display_name=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2`,[req.session.customerId,req.session.customerUserId,name]);
    await client.query(`UPDATE app_users SET pending_email=$2,pending_email_requested_at=NOW(),updated_at=NOW() WHERE id=$1`,[req.session.customerUserId,nextEmail]);
    await invalidate(client,req.session.customerUserId,[EMAIL_OLD_TOKEN,EMAIL_NEW_TOKEN,'email_change']);
    await client.query(`INSERT INTO account_tokens(user_id,token_type,token_hash,expires_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,[req.session.customerUserId,EMAIL_OLD_TOKEN,tokenHash(raw),expiresAt,JSON.stringify({email:nextEmail,oldEmail,displayName:name,customerId:req.session.customerId})]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.email_change.request','customer',$2,$3::jsonb)`,[req.session.customerUserId,req.session.customerId,JSON.stringify({pendingEmail:nextEmail,approval:'old_verified_email',expiresAt})]);
  });
  const url=await absolute(req,`/account/confirm-portal-email-old?token=${encodeURIComponent(raw)}`),site=runtimeSettings.siteName();
  await sendSecurityMail({to:oldEmail,subject:`Approve your ${site} email change`,title:'Approve portal email change',text:`A request was made to change your portal email to ${emailChange.maskEmail(nextEmail)}. Your current email remains in control until you approve this request.`,actionLabel:'Approve email change',actionUrl:url,dedupeKey:`portal-email-old:${req.session.customerUserId}:${expiresAt.toISOString()}`});
  return {oldEmail,nextEmail,expiresAt};
}

async function approveOldEmail(raw){
  const nextRaw=rawToken(),expiresAt=expiry(EMAIL_TTL_MINUTES);
  const result=await transaction(async client=>{
    const token=await tokenForUpdate(client,raw,EMAIL_OLD_TOKEN);if(!token)return null;
    const row=(await client.query(`SELECT u.email,u.email_verified_at,u.pending_email,c.id customer_id FROM app_users u JOIN customers c ON c.user_id=u.id WHERE u.id=$1 AND u.role='customer' FOR UPDATE OF u,c`,[token.user_id])).rows[0];if(!row)return null;
    const nextEmail=emailChange.cleanEmail(token.metadata?.email),oldEmail=String(token.metadata?.oldEmail||'').toLowerCase();
    if(!row.email_verified_at||String(row.email||'').toLowerCase()!==oldEmail||String(row.pending_email||'').toLowerCase()!==nextEmail){await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);return null;}
    const duplicate=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,[nextEmail,token.user_id]);if(duplicate.rowCount)throw new Error('That email address is already in use.');
    await invalidate(client,token.user_id,[EMAIL_NEW_TOKEN]);
    await client.query(`INSERT INTO account_tokens(user_id,token_type,token_hash,expires_at,metadata) VALUES($1,$2,$3,$4,$5::jsonb)`,[token.user_id,EMAIL_NEW_TOKEN,tokenHash(nextRaw),expiresAt,JSON.stringify({...token.metadata,email:nextEmail,oldEmail})]);
    await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.email_change.old_email_approved','customer',$2,$3::jsonb)`,[token.user_id,row.customer_id,JSON.stringify({pendingEmail:nextEmail,expiresAt})]);
    return {userId:token.user_id,customerId:row.customer_id,nextEmail,oldEmail,nextRaw,expiresAt};
  });
  if(!result)return null;
  await runtimeSettings.ensureLoaded();const site=runtimeSettings.siteName(),url=await absoluteFromConfiguredBase(`/account/confirm-portal-email-new?token=${encodeURIComponent(result.nextRaw)}`);
  await sendSecurityMail({to:result.nextEmail,subject:`Verify your new ${site} email address`,title:'Verify your new email address',text:'Your current verified email approved this change. Verify this new email address to complete the portal email change.',actionLabel:'Verify new email',actionUrl:url,eventLabel:'Email verification',tone:'info',dedupeKey:`portal-email-new:${result.userId}:${result.expiresAt.toISOString()}`});
  return result;
}

async function completeNewEmail(raw){
  const result=await transaction(async client=>{
    const token=await tokenForUpdate(client,raw,EMAIL_NEW_TOKEN);if(!token)return null;
    const row=(await client.query(`SELECT u.email,u.pending_email,c.id customer_id FROM app_users u JOIN customers c ON c.user_id=u.id WHERE u.id=$1 AND u.role='customer' FOR UPDATE OF u,c`,[token.user_id])).rows[0];if(!row)return null;
    const email=emailChange.cleanEmail(token.metadata?.email),oldEmail=String(token.metadata?.oldEmail||row.email||'').toLowerCase();
    if(String(row.email||'').toLowerCase()!==oldEmail||String(row.pending_email||'').toLowerCase()!==email){await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);return null;}
    const duplicate=await client.query(`SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,[email,token.user_id]);if(duplicate.rowCount)throw new Error('That email address is already in use.');
    await client.query(`UPDATE app_users SET email=$2,email_verified_at=NOW(),pending_email=NULL,pending_email_requested_at=NULL,session_version=session_version+1,updated_at=NOW() WHERE id=$1`,[token.user_id,email]);
    await client.query(`UPDATE customers SET email=$2,updated_at=NOW() WHERE user_id=$1`,[token.user_id,email]);
    const revoked=await revokeAllSessions(client,token.user_id);
    await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
    await invalidate(client,token.user_id,[PASSWORD_TOKEN,EMAIL_OLD_TOKEN,'email_change']);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'customer.email_change.complete','customer',$2,$3::jsonb)`,[token.user_id,row.customer_id,JSON.stringify({email,verified:true,approval:'old_verified_email',newEmailVerified:true,revokedSessions:revoked})]);
    return {userId:token.user_id,customerId:row.customer_id,email,oldEmail,revoked};
  });
  if(result){const site=runtimeSettings.siteName(),base=await baseUrl(),securityUrl=base?`${base}/account/security`:'';sendSecurityMail({to:result.oldEmail,subject:`${site} email address changed`,title:'Portal email address changed',text:`Your portal email address was changed to ${emailChange.maskEmail(result.email)} after approval from the previous address and verification of the new address. All portal sessions were signed out. If this was not you, contact support immediately.`,actionLabel:securityUrl?'Review account security':'Contact support',actionUrl:securityUrl||'#',dedupeKey:null}).catch(error=>console.warn('Old-email completion notice failed:',error.message));}
  return result;
}

function createPortalCredentialConfirmationRouter(){
  const router=express.Router();router.use(['/account/confirm-portal-password','/account/confirm-portal-email-old','/account/confirm-portal-email-new'],noStore);
  // These are policy interceptors, not competing route owners. The existing
  // customer-security router remains the canonical owner of the POST paths.
  router.use('/account/security/password',onlyPost,requireCustomer,csrfGuard,async(req,res)=>{try{const change=await requestPasswordChange(req);return res.redirect('/account/security?message='+encodeURIComponent(`Confirmation sent to ${emailChange.maskEmail(change.email)}. Your portal password has not changed yet.`));}catch(error){return res.redirect('/account/security?error='+encodeURIComponent(String(error.message||'Password change could not be requested.')));}});
  router.use('/account/security/profile',onlyPost,requireCustomer,csrfGuard,async(req,res,next)=>{try{const current=await emailChange.identity(req.session.customerId,req.session.customerUserId),nextEmail=emailChange.cleanEmail(req.body.email);if(String(current.email||'').toLowerCase()===nextEmail)return next('router');if(!String(req.body.currentPassword||''))return next('router');const change=await requestEmailChange(req,current,nextEmail,req.body.displayName);return res.redirect('/account/security?message='+encodeURIComponent(`Approval sent to your current verified email (${emailChange.maskEmail(change.oldEmail)}). The new email is not active yet.`));}catch(error){return res.redirect('/account/security?error='+encodeURIComponent(String(error.message||'Email change could not be requested.')));}});
  router.get('/account/confirm-portal-password',async(req,res)=>{const raw=String(req.query.token||'');if(!raw)return res.status(400).send(await resultPage('Invalid link','This password-change confirmation link is incomplete.'));return res.send(await page('Confirm portal password change','Approve this request to replace your portal password and sign out every existing portal session.','/account/confirm-portal-password',{raw,csrf:csrf.token(req)},'Approve password change'));});
  router.post('/account/confirm-portal-password',csrfGuard,async(req,res)=>{const done=await completePasswordChange(req.body.token).catch(()=>null);if(!done)return res.status(400).send(await resultPage('Password not changed','This confirmation link is invalid, expired, already used, or the account security details changed after the request was created.'));await customerSession.destroy(req).catch(()=>{});return res.send(await resultPage('Portal password changed',`Your portal password was changed and ${done.revoked} portal session(s) were signed out.`));});
  router.get('/account/confirm-portal-email-old',async(req,res)=>{const raw=String(req.query.token||'');if(!raw)return res.status(400).send(await resultPage('Invalid link','This email-change approval link is incomplete.'));return res.send(await page('Approve portal email change','Approve the request from your current verified email. The new address will still have to be verified before it becomes active.','/account/confirm-portal-email-old',{raw,csrf:csrf.token(req)},'Approve and send new-email verification'));});
  router.post('/account/confirm-portal-email-old',csrfGuard,async(req,res)=>{try{const approved=await approveOldEmail(req.body.token);if(!approved)return res.status(400).send(await resultPage('Email not changed','This approval link is invalid, expired or already used.'));return res.send(await resultPage('Current email approved','Approval succeeded. A separate verification message has been sent to the new email address. Your current email remains active until that verification is completed.'));}catch(error){return res.status(400).send(await resultPage('Email approval failed',String(error.message||'The email change could not be approved.')));}});
  router.get('/account/confirm-portal-email-new',async(req,res)=>{const raw=String(req.query.token||'');if(!raw)return res.status(400).send(await resultPage('Invalid link','This new-email verification link is incomplete.'));return res.send(await page('Verify new portal email','Verify ownership of this new email address to complete the portal email change. All portal sessions will be signed out.','/account/confirm-portal-email-new',{raw,csrf:csrf.token(req)},'Verify and change email'));});
  router.post('/account/confirm-portal-email-new',csrfGuard,async(req,res)=>{try{const done=await completeNewEmail(req.body.token);if(!done)return res.status(400).send(await resultPage('Email not changed','This verification link is invalid, expired, already used, or the pending change no longer matches the account.'));await customerSession.destroy(req).catch(()=>{});return res.send(await resultPage('Portal email changed',`Your new portal email is verified and active. ${done.revoked} portal session(s) were signed out.`));}catch(error){return res.status(400).send(await resultPage('Email verification failed',String(error.message||'The email change could not be completed.')));}});
  return router;
}

module.exports={createPortalCredentialConfirmationRouter,requestPasswordChange,completePasswordChange,requestEmailChange,approveOldEmail,completeNewEmail,PASSWORD_TOKEN,EMAIL_OLD_TOKEN,EMAIL_NEW_TOKEN};
