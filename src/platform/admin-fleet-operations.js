'use strict';

const express=require('express');
const csrf=require('../auth/csrf');
const {query}=require('../db');
const operations=require('./operations-settings');
const runtimeSettings=require('./runtime-settings');
const placementPreview=require('../jellyfin/placement-preview');
const {layout,esc}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function modeLabel(mode){return mode==='drain'?'Drain':mode==='maintenance'?'Maintenance':'Active';}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}

async function data(){
  const [settings,servers,plans]=await Promise.all([
    operations.get(),
    query(`SELECT id,name,server_class,health_status,COALESCE(placement_mode,'active') placement_mode,allow_new_users,max_users FROM jellyfin_servers WHERE enabled=TRUE ORDER BY priority,name`),
    query(`SELECT id,name,code,placement_strategy FROM plans WHERE active=TRUE AND archived_at IS NULL AND (effective_from IS NULL OR effective_from<=NOW()) AND (effective_until IS NULL OR effective_until>NOW()) ORDER BY sort_order,name`)
  ]);
  return{settings,servers:servers.rows,plans:plans.rows};
}

async function page(req,preview=null){
  await runtimeSettings.ensureLoaded();const d=await data(),s=d.settings;
  const serverRows=d.servers.length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Server</th><th>Health</th><th>New placement</th><th>Mode</th></tr></thead><tbody>${d.servers.map(x=>`<tr><td><strong>${esc(x.name)}</strong><div class="subText">${esc(x.server_class)}${x.max_users?` · max ${esc(x.max_users)}`:''}</div></td><td><span class="pill ${x.health_status==='healthy'?'good':x.health_status==='offline'?'bad':'warn'}">${esc(x.health_status||'unknown')}</span></td><td>${x.allow_new_users?'Allowed':'Disabled'}</td><td><form class="inlineForm" method="post" action="/admin/servers/operations/server/${esc(x.id)}/placement-mode">${token(req)}<select class="input" name="mode"><option value="active" ${x.placement_mode==='active'?'selected':''}>Active</option><option value="drain" ${x.placement_mode==='drain'?'selected':''}>Drain — no new placements</option><option value="maintenance" ${x.placement_mode==='maintenance'?'selected':''}>Maintenance — no new placements</option></select><button class="button secondary btn-sm">Set ${esc(modeLabel(x.placement_mode))}</button></form></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No enabled Jellyfin servers.</div>';
  const previewHtml=preview?`<div class="statusBanner"><strong>Dry run:</strong> ${esc(preview.requested)} hypothetical new users on ${esc(preview.plan.name)}; ${esc(preview.unplaced)} could not be placed.</div><div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Server</th><th>Health</th><th>Existing</th><th>Simulated new</th><th>Max</th></tr></thead><tbody>${preview.servers.map(x=>`<tr><td>${esc(x.name)}</td><td>${esc(x.health)}</td><td>${esc(x.existingUsers)}</td><td><strong>${esc(x.simulatedNewUsers)}</strong></td><td>${esc(x.maxUsers||'∞')}</td></tr>`).join('')}</tbody></table></div>`:'';
  const body=`${notice(req)}<div class="operatorCallout"><strong>Fleet operations affect future placement, not existing access.</strong> Drain and Maintenance stop new assignments while preserving customers already hosted on the server.</div><section class="section"><div class="sectionHead"><div><h2>Placement health policy</h2><div class="muted">Choose which server health states may receive a new customer.</div></div></div><form class="formPanel" method="post" action="/admin/servers/operations/placement-policy">${token(req)}<div class="formGroup"><label>Eligible health</label><select class="input" name="placementHealthMode"><option value="healthy_only" ${s.placementHealthMode==='healthy_only'?'selected':''}>Healthy only</option><option value="healthy_or_degraded" ${s.placementHealthMode==='healthy_or_degraded'?'selected':''}>Healthy or degraded</option><option value="fail_open" ${s.placementHealthMode==='fail_open'?'selected':''}>Fail open except offline</option></select><div class="inlineHelp">Healthy or degraded is the normal resilient default. Fail-open is useful only when availability matters more than avoiding degraded hosts.</div></div><button class="button">Save placement policy</button></form></section><section class="section"><div class="sectionHead"><div><h2>Server placement modes</h2><div class="muted">Temporarily remove a server from new placements without disrupting its current customers.</div></div></div>${serverRows}</section><section class="section"><div class="sectionHead"><div><h2>Placement dry run</h2><div class="muted">Simulate future assignments without creating users or modifying capacity.</div></div></div><form class="formPanel" method="post" action="/admin/servers/operations/placement-preview">${token(req)}<div class="formGrid"><div class="formGroup"><label>Plan</label><select class="input" name="planId" required>${d.plans.map(p=>`<option value="${esc(p.id)}">${esc(p.name)} · ${esc(p.placement_strategy||'balanced')}</option>`).join('')}</select></div><div class="formGroup"><label>Hypothetical new users</label><input class="input" type="number" name="count" min="1" max="1000" value="25"></div></div><button class="button secondary">Run placement preview</button></form>${previewHtml}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'fleet-operations',title:'Fleet operations',subtitle:'Placement safety, drain/maintenance and capacity simulation',body});
}

function createAdminFleetOperationsRouter(){
  const r=express.Router();r.use('/admin/servers/operations',gate,noStore);
  r.get('/admin/servers/operations',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});
  r.post('/admin/servers/operations/placement-policy',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const mode=['healthy_only','healthy_or_degraded','fail_open'].includes(req.body.placementHealthMode)?req.body.placementHealthMode:null;if(!mode)throw new Error('Choose a valid placement health policy.');await operations.patch({placementHealthMode:mode},req.session.authUserId);return res.redirect('/admin/servers/operations?message='+encodeURIComponent('Placement health policy saved.'));}catch(error){return res.redirect('/admin/servers/operations?error='+encodeURIComponent(error.message));}});
  r.post('/admin/servers/operations/server/:id/placement-mode',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const mode=['active','drain','maintenance'].includes(req.body.mode)?req.body.mode:null;if(!mode)throw new Error('Unknown placement mode.');const result=await query(`UPDATE jellyfin_servers SET placement_mode=$2,updated_at=NOW() WHERE id=$1 RETURNING name`,[req.params.id,mode]);if(!result.rowCount)throw new Error('Server not found.');await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.server.placement_mode','jellyfin_server',$2,$3::jsonb)`,[req.session.authUserId,req.params.id,JSON.stringify({mode})]);return res.redirect('/admin/servers/operations?message='+encodeURIComponent(`${result.rows[0].name} placement mode is now ${mode}.`));}catch(error){return res.redirect('/admin/servers/operations?error='+encodeURIComponent(error.message));}});
  r.post('/admin/servers/operations/placement-preview',async(req,res,next)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{return res.send(await page(req,await placementPreview.preview(req.body.planId,req.body.count)));}catch(error){next(error);}});
  return r;
}

module.exports={createAdminFleetOperationsRouter,page,data};
