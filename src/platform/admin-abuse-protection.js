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
  const body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<div class="statusBanner"><strong>Optional anti-abuse layer.</strong> CAPTAiNFiN rate limits public actions independently. Turnstile is disabled by default and only becomes a dependency for the selected forms after you enable it.</div><section class="section"><form class="formPanel compactSettingsForm" method="post" action="/admin/settings/abuse-protection"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">
  ${settingControls.toggle({name:'turnstileEnabled',label:'Enable Cloudflare Turnstile',description:'Adds a challenge only to the public flows selected below.',checked:cfg.enabled})}
  <div class="formGrid"><div class="formGroup"><label for="turnstileSiteKey">Site key</label><input class="input" id="turnstileSiteKey" name="turnstileSiteKey" maxlength="200" value="${esc(cfg.siteKey||'')}" placeholder="0x4AAAA..."></div><div class="formGroup"><label for="turnstileSecret">Secret key</label><input class="input" id="turnstileSecret" type="password" name="turnstileSecret" maxlength="500" autocomplete="new-password" placeholder="${cfg.secretConfigured?'Configured — leave blank to keep':'0x4AAAA...'}">${settingControls.toggle({name:'clearTurnstileSecret',label:'Clear stored secret',description:'Remove the encrypted Turnstile secret on save.',tone:'danger',confirmWhenChecked:'Clear the stored Cloudflare Turnstile secret? Protected public forms cannot verify Turnstile until a new secret is saved.'})}</div></div>
  ${settingControls.grid([{name:'protectRegistration',label:'Protect public registration',checked:cfg.protectRegistration},{name:'protectPasswordReset',label:'Protect password-reset requests',checked:cfg.protectPasswordReset}])}
  <div class="securityNote standalone">The secret is encrypted at rest. The browser receives only the public site key. A submitted token is verified server-side before the existing registration/reset handler is allowed to run.</div><button class="button">Save abuse protection</button></form></section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'abuse-protection',title:'Abuse protection',subtitle:'Rate limits and optional Turnstile verification for public account flows',body});
}
function createAdminAbuseProtectionRouter(){const r=express.Router();r.use('/admin/settings/abuse-protection',gate,noStore);r.get('/admin/settings/abuse-protection',async(req,res,next)=>{try{return res.send(await page(req))}catch(e){next(e)}});r.post('/admin/settings/abuse-protection',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await protection.save(req.body,req.session.authUserId);return res.redirect('/admin/settings/abuse-protection?message='+encodeURIComponent('Public abuse protection settings saved.'))}catch(e){return res.redirect('/admin/settings/abuse-protection?error='+encodeURIComponent(e.message))}});return r}
module.exports={createAdminAbuseProtectionRouter,page};
