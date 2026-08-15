'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');
const {layout,esc}=require('./admin-html');

const stremioMutationLimit=routeRateLimit.middleware({scope:'admin-stremio-settings',max:20,windowSeconds:300});
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function csrfInput(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}
function money(minor,currency='USD'){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'USD')}).format(Number(minor||0)/100);}catch{return `${currency} ${(Number(minor||0)/100).toFixed(2)}`;}}

async function data(){
    const [plans,servers,entitlements]=await Promise.all([
        query(`SELECT id,code,name,service_type,streams,active,visible,price_minor,currency
               FROM plans ORDER BY archived_at IS NOT NULL,active DESC,sort_order,price_minor,name`),
        query(`SELECT id,name,server_class,public_url,enabled,health_status,stremio_enabled
               FROM jellyfin_servers ORDER BY enabled DESC,priority,name`),
        query(`SELECT COUNT(*)::int total,
                      COUNT(*) FILTER(WHERE status='active')::int active,
                      COUNT(*) FILTER(WHERE status='pending')::int pending,
                      COUNT(*) FILTER(WHERE status='suspended')::int suspended,
                      COUNT(*) FILTER(WHERE status='revoked')::int revoked
               FROM stremio_entitlements`)
    ]);
    return {plans:plans.rows,servers:servers.rows,entitlements:entitlements.rows[0]||{total:0,active:0,pending:0,suspended:0,revoked:0}};
}

async function page(req){
    await runtimeSettings.ensureLoaded();
    const d=await data(),e=d.entitlements;
    const stremioPlans=d.plans.filter(plan=>plan.service_type==='stremio'||plan.service_type==='bundle');
    const eligibleServers=d.servers.filter(server=>server.stremio_enabled);
    const body=`${notice(req)}
    <div class="statusBanner warn"><strong>Foundation only:</strong> the control-plane schema and stream-label parser are being prepared here, but the production Stremio addon/runtime is not enabled yet. Do not sell Stremio access until the playback project is released and tested.</div>
    <div class="metrics">
      <div class="metric"><div class="metricLabel">Stremio/bundle plans</div><div class="metricValue">${stremioPlans.length}</div></div>
      <div class="metric"><div class="metricLabel">Eligible Jellyfin servers</div><div class="metricValue">${eligibleServers.length}</div></div>
      <div class="metric"><div class="metricLabel">Active entitlements</div><div class="metricValue">${Number(e.active||0)}</div></div>
      <div class="metric"><div class="metricLabel">Pending entitlements</div><div class="metricValue">${Number(e.pending||0)}</div></div>
    </div>
    <section class="section"><div class="sectionHead"><div><h2>Delivery model</h2><div class="settings-hint">Existing plans remain Jellyfin-only until explicitly migrated by a future runtime-aware workflow.</div></div><span class="pill accent">$4 / stream working concept</span></div><div class="card-body"><div class="quick-actions"><div class="quick-action"><strong>Jellyfin</strong><span>Normal Jellyfin customer access and policy.</span></div><div class="quick-action"><strong>Stremio</strong><span>Future stream-only addon backed by a restricted Jellyfin identity.</span></div><div class="quick-action"><strong>Bundle</strong><span>Future product that exposes both customer surfaces.</span></div><div class="quick-action"><strong>Per-user install credential</strong><span>Opaque, rotatable bearer credential stored only as a one-way hash.</span></div></div></div></section>
    <section class="section"><div class="sectionHead"><div><h2>Jellyfin servers eligible for Stremio</h2><div class="settings-hint">This flag is preparation only and does not change normal Jellyfin placement or expose a live addon.</div></div></div>${d.servers.length?`<div class="tableWrap"><table class="dataTable"><thead><tr><th>Server</th><th>Class</th><th>Public URL</th><th>Health</th><th>Stremio</th><th></th></tr></thead><tbody>${d.servers.map(server=>`<tr><td><strong>${esc(server.name)}</strong>${!server.enabled?'<div class="subText">Server disabled</div>':''}</td><td>${esc(server.server_class)}</td><td>${esc(server.public_url||'Not configured')}</td><td><span class="pill ${server.health_status==='healthy'?'good':server.health_status==='offline'?'bad':'warn'}">${esc(server.health_status||'unknown')}</span></td><td><span class="pill ${server.stremio_enabled?'good':'warn'}">${server.stremio_enabled?'Eligible':'Not eligible'}</span></td><td><form method="post" action="/admin/settings/stremio/servers/${esc(server.id)}">${csrfInput(req)}<input type="hidden" name="enabled" value="${server.stremio_enabled?'0':'1'}"><button class="button secondary btn-sm" type="submit">${server.stremio_enabled?'Remove eligibility':'Mark eligible'}</button></form></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No Jellyfin servers configured.</div>'}</section>
    <section class="section"><div class="sectionHead"><div><h2>Plan delivery state</h2><div class="settings-hint">Read-only until the addon runtime can safely honour these product types end to end.</div></div></div><div class="tableWrap"><table class="dataTable"><thead><tr><th>Plan</th><th>Delivery</th><th>Streams</th><th>Price</th><th>Status</th></tr></thead><tbody>${d.plans.map(plan=>`<tr><td><strong>${esc(plan.name)}</strong><div class="subText">${esc(plan.code)}</div></td><td><span class="pill ${plan.service_type==='jellyfin'?'accent':plan.service_type==='bundle'?'good':'warn'}">${esc(plan.service_type)}</span></td><td>${esc(plan.streams)}</td><td>${esc(money(plan.price_minor,plan.currency))}</td><td>${plan.active?'<span class="pill good">Active</span>':'<span class="pill warn">Inactive</span>'}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="section"><div class="sectionHead"><div><h2>Entitlement security</h2><div class="settings-hint">Control-plane records exist now so the later addon does not need to invent authentication storage.</div></div></div><div class="card-body"><div class="compact-item"><div><div class="compact-title">Raw addon credentials</div><div class="compact-meta">Generated with high entropy and returned only when issued/rotated.</div></div><span class="pill good">Never stored</span></div><div class="compact-item"><div><div class="compact-title">Stored credential</div><div class="compact-meta">SHA-256 hash plus a short non-secret hint for support identification.</div></div><span class="pill good">Hash only</span></div><div class="compact-item"><div><div class="compact-title">Revocation</div><div class="compact-meta">Token version/status fields support invalidating a previous addon installation.</div></div><span class="pill accent">Prepared</span></div><div class="compact-item"><div><div class="compact-title">Current records</div><div class="compact-meta">Total ${Number(e.total||0)} · suspended ${Number(e.suspended||0)} · revoked ${Number(e.revoked||0)}</div></div><span class="pill accent">${Number(e.total||0)}</span></div></div></section>`;
    return layout({siteName:runtimeSettings.siteName(),active:'stremio-settings',title:'Stremio',subtitle:'Future stream-only delivery foundation, Jellyfin eligibility and entitlement security',body});
}

function createAdminStremioRouter(){
    const router=express.Router();
    router.use('/admin/settings/stremio',gate,noStore);
    router.get('/admin/settings/stremio',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){return next(error);}});
    router.post('/admin/settings/stremio/servers/:id',stremioMutationLimit,async(req,res)=>{
        if(!csrf.verify(req))return res.status(403).send('Invalid security token');
        try{
            const enabled=String(req.body.enabled)==='1';
            await transaction(async client=>{
                const server=await client.query('SELECT id,name,stremio_enabled FROM jellyfin_servers WHERE id=$1 FOR UPDATE',[req.params.id]);
                if(!server.rowCount)throw new Error('Jellyfin server not found.');
                if(!enabled){
                    const assigned=await client.query(`SELECT COUNT(*)::int n FROM stremio_entitlements WHERE server_id=$1 AND status IN ('pending','active','suspended')`,[req.params.id]);
                    if(Number(assigned.rows[0]?.n||0)>0)throw new Error('Move or revoke assigned Stremio entitlements before removing this server from Stremio eligibility.');
                }
                await client.query('UPDATE jellyfin_servers SET stremio_enabled=$2,updated_at=NOW() WHERE id=$1',[req.params.id,enabled]);
                await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.stremio.server_eligibility','jellyfin_server',$2,$3::jsonb)`,[req.session.authUserId,req.params.id,JSON.stringify({enabled})]);
            });
            return res.redirect('/admin/settings/stremio?message='+encodeURIComponent(enabled?'Server marked eligible for future Stremio delivery.':'Server removed from future Stremio eligibility.'));
        }catch(error){return res.redirect('/admin/settings/stremio?error='+encodeURIComponent(error.message));}
    });
    return router;
}

module.exports={createAdminStremioRouter,page,data};
