'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const {query}=require('../db');
const emailChange=require('../security/customer-email-change');
const emailSettings=require('../integrations/email-settings');
const emailOutbox=require('../integrations/email-outbox');
const {renderProfessionalEmail}=require('../integrations/email-template');
const runtimeSettings=require('./runtime-settings');
const operations=require('./operations-settings');
const adminHtml=require('./admin-html');
const recoveryCommands=require('../security/admin-portal-credential-recovery');

const adminRecoveryLimit=routeRateLimit.middleware({scope:'admin-portal-credential-recovery',max:20,windowSeconds:300,reason:'admin_portal_credential_recovery'});

function gate(req,res,next){if(req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId)return next();return res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function cleanReason(value){const reason=String(value||'').trim().slice(0,500);if(reason.length<8)throw new Error('Enter a short recovery reason (at least 8 characters).');return reason;}
function back(customerId,message='',error=''){const q=error?`error=${encodeURIComponent(error)}`:`message=${encodeURIComponent(message)}`;return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${q}#portal-access`;}
function requestMeta(req){return{ip:String(req.ip||req.socket?.remoteAddress||'').slice(0,100),userAgent:String(req.get?.('user-agent')||'').slice(0,300)};}


async function notifyPreviousAddress({to,emailChanged,passwordChanged,twoFactorCleared}){
  try{
    if(!to)return;
    const mail=await emailSettings.status();if(!mail.configured)return;
    await runtimeSettings.ensureLoaded();const site=runtimeSettings.siteName(),cfg=await operations.get().catch(()=>operations.DEFAULTS),base=String(cfg.publicBaseUrl||'').replace(/\/+$/,'');
    const changes=[emailChanged?'portal email':'',passwordChanged?'portal password':'',twoFactorCleared?'portal 2FA':''].filter(Boolean).join(', ');
    await emailOutbox.enqueue({type:'admin_portal_credential_recovery',to,subject:`${site} account recovery performed`,text:`An administrator performed assisted account recovery for your ${site} portal account. Changed: ${changes}. All portal sessions were signed out. If you did not request this, contact support immediately.`,html:renderProfessionalEmail({subject:`${site} account recovery performed`,title:'Administrator-assisted account recovery',text:`An administrator changed ${changes} after an account-recovery request. All portal sessions were signed out. If you did not request this, contact support immediately.`,eventLabel:'Account recovery',tone:'warn',actionLabel:base?'Sign in to portal':'',actionUrl:base?`${base}/account/login`:'',siteName:site,publicBaseUrl:base}),dedupeKey:null});
  }catch(_){console.warn('Admin portal recovery notice failed');}
}

async function recoveryPage(req,res){
  const row=(await query(`SELECT c.id,c.display_name,c.user_id,u.username,u.email,u.email_verified_at,u.totp_enabled FROM customers c LEFT JOIN app_users u ON u.id=c.user_id WHERE c.id=$1`,[req.params.customerId])).rows[0];
  if(!row)return res.status(404).send('Customer not found');
  if(!row.user_id)return res.status(400).send(adminHtml.layout({title:'Portal credential recovery',active:'users',body:`<div class="notice error">This customer has no portal account.</div><p><a class="button" href="/admin/users/${encodeURIComponent(row.id)}?tab=access">Back to customer</a></p>`}));
  const token=csrf.token(req),verified=row.email_verified_at?'Verified':'Not verified',two=row.totp_enabled?'Enabled':'Off';
  const body=`<div class="sectionHead"><div><h1>Portal credential recovery</h1><p>Break-glass recovery for ${adminHtml.esc(row.display_name||row.username||'customer')}. This bypasses normal old-email confirmation and affects the CAPTAiNFiN portal only.</p></div></div>
  <div class="notice warn"><strong>High-impact action.</strong> Every portal session will be revoked. Jellyfin and Overseerr passwords are not changed.</div>
  <section class="panel"><p><strong>Portal username:</strong> ${adminHtml.esc(row.username||'—')}<br><strong>Current email:</strong> ${adminHtml.esc(row.email||'—')} (${verified})<br><strong>Portal 2FA:</strong> ${two}</p>
  <form method="post" action="/admin/users/${encodeURIComponent(row.id)}/portal-credential-recovery" data-native-submit="true">
    <input type="hidden" name="_csrf" value="${adminHtml.esc(token)}">
    <div class="formGrid"><div class="formGroup"><label>New portal email <span class="muted">(optional)</span></label><input class="input" type="email" name="email" maxlength="254" placeholder="Leave blank to keep current email"></div><div class="formGroup"><label>New portal password <span class="muted">(optional)</span></label><input class="input" type="password" name="password" minlength="8" maxlength="200" autocomplete="new-password" placeholder="Leave blank to keep current password"></div></div>
    <label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0"><input type="checkbox" name="clear2fa" value="1"> <span>Clear portal 2FA and recovery codes. Use this only when the customer cannot access the enrolled authenticator.</span></label>
    <div class="formGroup"><label>Recovery reason</label><textarea class="input" name="reason" maxlength="500" required placeholder="e.g. Customer verified by support and lost access to old email/authenticator"></textarea></div>
    <div class="formGroup"><label>Impact confirmation</label><input class="input" name="confirmation" autocomplete="off" required placeholder="Type RECOVER PORTAL"></div>
    <label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0"><input type="checkbox" name="verifiedCustomer" value="1" required> <span>I have verified I am assisting the correct customer and understand this bypasses normal email confirmation.</span></label>
    <div class="buttonRow"><button class="button danger" type="submit">Perform portal recovery</button><a class="button secondary" href="/admin/users/${encodeURIComponent(row.id)}?tab=access">Cancel</a></div>
  </form></section>`;
  return res.send(adminHtml.layout({title:'Portal credential recovery',active:'users',body}));
}

function createAdminPortalCredentialRecoveryRouter(){
  const router=express.Router();router.use('/admin/users/:customerId/portal-credential-recovery',gate,noStore);
  router.get('/admin/users/:customerId/portal-credential-recovery',recoveryPage);
  router.post('/admin/users/:customerId/portal-credential-recovery',adminRecoveryLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      if(String(req.body.confirmation||'').trim()!=='RECOVER PORTAL'||req.body.verifiedCustomer!=='1')throw new Error('Recovery confirmation was not completed.');
      const reason=cleanReason(req.body.reason),requestedEmail=String(req.body.email||'').trim(),password=String(req.body.password||''),clear2fa=req.body.clear2fa==='1';
      const outcome=await recoveryCommands.recover({
        customerId:req.params.customerId,
        actorUserId:req.session.authUserId,
        requestedEmail,
        password,
        clear2fa,
        reason,
        requestMeta:requestMeta(req)
      });
      if(outcome.oldEmailVerified)notifyPreviousAddress({to:outcome.oldEmail,...outcome}).catch(()=>{});
      return res.redirect(back(req.params.customerId,`Portal recovery completed. ${outcome.revoked} portal session(s) revoked. Jellyfin/Overseerr credentials were not changed.`));
    }catch(error){return res.redirect(back(req.params.customerId,'',String(error.message||'Portal recovery failed.')));}
  });
  return router;
}

module.exports={createAdminPortalCredentialRecoveryRouter,recoveryPage};