'use strict';
const express=require('express');
const csrf=require('../auth/csrf');
const protection=require('../security/public-abuse-protection');
const runtimeSettings=require('./runtime-settings');
const settingControls=require('./admin-setting-controls');
const {layout,esc}=require('./admin-html');
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired')}
function noStore(_q,res,next){res.setHeader('Cache-Control','no-store, private');res.setHeader('Pragma','no-cache');next()}
async function page(req){
  await runtimeSettings.ensureLoaded();
  const cfg=await protection.get();
  const body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<div class="statusBanner"><strong>Authentication bot protection.</strong> When Cloudflare Turnstile is enabled, every staff sign-in, customer sign-in and public account registration must pass Turnstile before CAPTAiNFiN checks a password or creates an account. Persistent rate limits and account security controls remain active as separate layers.</div><section class="section"><form class="formPanel compactSettingsForm" method="post" action="/admin/settings/abuse-protection"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">
  ${settingControls.toggle({name:'turnstileEnabled',label:'Enable Cloudflare Turnstile',description:'Requires Turnstile on all staff/customer sign-ins and public registrations.',checked:cfg.enabled})}
  <div class="formGrid"><div class="formGroup"><label for="turnstileSiteKey">Site key</label><input class="input" id="turnstileSiteKey" name="turnstileSiteKey" maxlength="200" value="${esc(cfg.siteKey||'')}" placeholder="0x4AAAA..."></div><div class="formGroup"><label for="turnstileSecret">Secret key</label><input class="input" id="turnstileSecret" type="password" name="turnstileSecret" maxlength="500" autocomplete="new-password" placeholder="${cfg.secretConfigured?'Configured — leave blank to keep':'0x4AAAA...'}">${settingControls.toggle({name:'clearTurnstileSecret',label:'Clear stored secret',description:'Remove the encrypted Turnstile secret on save.',tone:'danger',confirmWhenChecked:'Clear the stored Cloudflare Turnstile secret? Sign-in and registration challenges cannot verify until a new secret is saved.'})}</div></div>
  <div class="securityNote standalone"><strong>Always protected while enabled:</strong> administrator sign-in, customer sign-in and public registration. These core authentication gates cannot be individually disabled.</div>
  ${settingControls.grid([{name:'protectPasswordReset',label:'Also protect password-reset requests',checked:cfg.protectPasswordReset}])}
  <div class="securityNote standalone">The secret is encrypted at rest. The browser receives only the public site key. Each challenge is bound to its intended form and verified server-side before the corresponding authentication or registration handler runs.</div><button class="button">Save abuse protection</button></form></section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'abuse-protection',title:'Abuse protection',subtitle:'Turnstile, rate limits and authentication bot resistance',body});
}
function createAdminAbuseProtectionRouter(){const r=express.Router();r.use('/admin/settings/abuse-protection',gate,noStore);r.get('/admin/settings/abuse-protection',async(req,res,next)=>{try{return res.send(await page(req))}catch(e){next(e)}});r.post('/admin/settings/abuse-protection',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await protection.save(req.body,req.session.authUserId);return res.redirect('/admin/settings/abuse-protection?message='+encodeURIComponent('Public abuse protection settings saved.'))}catch(e){return res.redirect('/admin/settings/abuse-protection?error='+encodeURIComponent(e.message))}});return r}
module.exports={createAdminAbuseProtectionRouter,page};
