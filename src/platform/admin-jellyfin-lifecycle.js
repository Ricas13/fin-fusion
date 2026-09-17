'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const lifecyclePolicy=require('../entitlements/jellyfin-lifecycle-policy');
const checkboxForm=require('./admin-checkbox-form');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}
async function page(req){await runtimeSettings.ensureLoaded();const cfg=await lifecyclePolicy.get();const body=`${notice(req)}
<div class="operatorCallout statusInfo"><strong>Free Server inactivity has two rules.</strong> A new allocation must play once within its server's first-play grace. After activation, it must meet that server's minimum watched minutes inside its rolling playback window. Login and Jellyfin LastActivityDate do not count.</div>
<section class="section"><div class="sectionHead"><div><h2>Free Server lifecycle automation</h2><div class="muted">This page only controls whether enforcement runs and whether it is live or dry-run. Thresholds belong to each Free-class media server under Servers → Advanced settings.</div></div><span class="statusPill ${cfg.enabled?(cfg.dryRun?'statusWarn':'statusGood'):'statusInfo'}">${cfg.enabled?(cfg.dryRun?'Dry run':'Enforcing'):'Paused'}</span></div>
<form class="formPanel" method="post" action="/admin/settings/jellyfin-lifecycle">${token(req)}<input type="hidden" name="_lifecycleCheckboxes" value="1">
<div class="toggleGrid"><label class="toggleRow"><input type="checkbox" name="enabled" ${cfg.enabled?'checked':''}><span><strong>Enable inactivity enforcement</strong><small>Apply the two Free Server playback rules.</small></span></label><label class="toggleRow"><input type="checkbox" name="dryRun" ${cfg.dryRun?'checked':''}><span><strong>Dry run only</strong><small>Show who would be removed without deleting Jellyfin access.</small></span></label></div>
<div class="buttonRow"><button class="button">Save lifecycle automation</button><a class="button secondary" href="/admin/servers">Free Server settings</a></div></form></section>`;return layout({siteName:runtimeSettings.siteName(),active:'activity',title:'Jellyfin access lifecycle',subtitle:'Two Free Server rules; one execution switch',body,action:'<a class="button secondary" href="/admin/servers">Servers</a>'});}
function lifecycleFormInput(body={}){return checkboxForm.explicitCheckboxes(body,'_lifecycleCheckboxes',['enabled','dryRun']);}
function createAdminJellyfinLifecycleRouter(){const r=express.Router();r.use('/admin/settings/jellyfin-lifecycle',gate,noStore);r.get('/admin/settings/jellyfin-lifecycle',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error)}});r.post('/admin/settings/jellyfin-lifecycle',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await lifecyclePolicy.save(lifecycleFormInput(req.body),req.session.authUserId);return res.redirect('/admin/settings/jellyfin-lifecycle?message='+encodeURIComponent('Free Server lifecycle automation saved.'));}catch(error){return res.redirect('/admin/settings/jellyfin-lifecycle?error='+encodeURIComponent(error.message));}});r.get('/admin/activity/inactivity-policy',gate,(_req,res)=>res.redirect(302,'/admin/settings/jellyfin-lifecycle'));return r;}
module.exports={createAdminJellyfinLifecycleRouter,page,lifecycleFormInput};