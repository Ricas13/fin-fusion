'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const {encryptWithEnv}=require('../security/purpose-crypto');
const managed=require('../stremio/managed-sources');
const {probeCredentials}=require('./admin-servers');
const runtimeSettings=require('./runtime-settings');
const {esc,layout}=require('./admin-html');

const mutationLimit=routeRateLimit.middleware({scope:'admin-stremio-managed-sources',max:30,windowSeconds:300});
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`;}
function pill(text,tone=''){return `<span class="pill ${tone}">${esc(text)}</span>`;}
function apiKey(value){const key=String(value||'').trim();if(!key)return null;if(key.length<16||key.length>256||/[\s\x00-\x1f\x7f]/.test(key))throw new Error('Jellyfin API key format is invalid.');return key;}

async function rotateApiKey({serverId,value,actorUserId}){
  const key=apiKey(value);if(!key)return false;
  const server=await managed.get(serverId);if(!server)throw new Error('Jellyfin server not found.');
  await probeCredentials(server.base_url,key);
  await query(`UPDATE jellyfin_servers SET api_key_encrypted=$2,health_status='unknown',updated_at=NOW() WHERE id=$1`,[serverId,encryptWithEnv(key,'JELLYFIN_ENCRYPTION_KEY','jf1')]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.stremio.managed_source.api_key.rotate','jellyfin_server',$2,'{"credentialRotated":true}'::jsonb)`,[actorUserId,serverId]);
  return true;
}
async function preflight(serverId,enabled,priorityValue){
  const sourcePriority=managed.priority(priorityValue||100),server=await managed.get(serverId);
  if(!server)throw new Error('Jellyfin server not found.');
  if(enabled&&!server.enabled)throw new Error('Enable the Jellyfin server before enabling it for Stremio.');
  if(enabled&&!server.public_url)throw new Error('A public Jellyfin URL is required for direct Stremio playback.');
  return{server,sourcePriority};
}

function row(req,server){
  const playable=Boolean(server.public_url),healthy=server.health_status==='healthy';
  const status=server.stremio_enabled?pill('Managed source','good'):pill('Not used','');
  const readiness=!server.api_configured?pill('API key required','bad'):!playable?pill('Public URL required','bad'):healthy?pill('Ready','good'):pill(server.health_status||'unknown','warn');
  return `<tr><td><strong>${esc(server.name)}</strong><div class="subText">${esc(server.server_class)}${server.public_url?` · ${esc(server.public_url)}`:''}</div></td><td>${status}<div class="subText">${Number(server.managed_stremio_accounts||0)} active hidden account${Number(server.managed_stremio_accounts||0)===1?'':'s'}</div></td><td>${readiness}</td><td><form class="managedSourceForm" method="post" action="/admin/servers/stremio/managed/${esc(server.id)}" autocomplete="off">${token(req)}<label class="checkRow"><input type="checkbox" name="enabled" value="1" ${server.stremio_enabled?'checked':''}><span>Use for Stremio</span></label><label>Source priority <input class="input compact" type="number" min="1" max="10000" name="priority" value="${Number(server.stremio_priority||100)}"></label><label>Jellyfin API key <input class="input" type="password" name="apiKey" minlength="16" maxlength="256" autocomplete="new-password" placeholder="${server.api_configured?'Configured — leave blank to keep':'Paste API key'}"></label><div class="subText">Write-only. Leaving this blank keeps the current key.</div><div class="buttonRow"><button class="button secondary btn-sm">Save</button><a class="button secondary btn-sm" href="/admin/servers/${esc(server.id)}/edit">Full server settings</a></div></form></td></tr>`;
}

async function page(req){
  await runtimeSettings.ensureLoaded();
  const servers=await managed.list(),enabled=servers.filter(s=>s.stremio_enabled).length;
  const body=`${notice(req)}<div class="statusBanner"><strong>Managed Stremio sources stay private.</strong> Customers never see these server names or whether a result is managed. CAPTAiNFiN uses each server's write-only Jellyfin API credential only on the backend; customer playback uses restricted hidden Jellyfin identities instead of exposing the administrator API key.</div><section class="section"><div class="sectionHead"><div><h2>Your Jellyfin servers</h2><div class="muted">Enable the servers that should supply the first Stremio results. Lower priority numbers are returned first. ${enabled} currently enabled.</div></div><a class="button secondary" href="/admin/servers/stremio">External sources</a></div>${servers.length?`<div class="tableWrap"><table class="dataTable"><thead><tr><th>Server</th><th>Stremio</th><th>Readiness</th><th>Configuration</th></tr></thead><tbody>${servers.map(s=>row(req,s)).join('')}</tbody></table></div>`:'<div class="empty">No Jellyfin servers are configured.</div>'}</section><div class="securityNote standalone"><strong>Credential boundary:</strong> API keys are write-only and never rendered back to the browser or embedded in Stremio results. They are used only by CAPTAiNFiN to provision and manage restricted hidden playback identities.</div><style>.managedSourceForm{display:grid;gap:8px;min-width:300px}.managedSourceForm label{display:grid;gap:4px}.managedSourceForm .compact{max-width:130px}.managedSourceForm .checkRow{display:flex}</style>`;
  return layout({siteName:runtimeSettings.siteName(),active:'stremio-managed-sources',title:'Managed Stremio sources',subtitle:'Your Jellyfin fleet as private, CAPTAiNFiN-controlled Stremio sources',body});
}

function createAdminStremioManagedSourcesRouter(){
  const router=express.Router();
  router.use('/admin/servers/stremio/managed',gate,noStore);
  router.get('/admin/servers/stremio/managed',async(req,res,next)=>{try{return res.send(await page(req));}catch(error){next(error);}});
  router.post('/admin/servers/stremio/managed/:serverId',mutationLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{
      const enabled=req.body.enabled==='1',checked=await preflight(req.params.serverId,enabled,req.body.priority);
      const rotated=await rotateApiKey({serverId:req.params.serverId,value:req.body.apiKey,actorUserId:req.session.authUserId});
      await managed.configure({serverId:req.params.serverId,enabled,sourcePriority:checked.sourcePriority,actorUserId:req.session.authUserId});
      const message=`Managed Stremio source ${enabled?'enabled':'disabled'}.${rotated?' Jellyfin API key rotated.':''}`;
      return res.redirect('/admin/servers/stremio/managed?message='+encodeURIComponent(message));
    }catch(error){return res.redirect('/admin/servers/stremio/managed?error='+encodeURIComponent(error.message));}
  });
  return router;
}

module.exports={createAdminStremioManagedSourcesRouter,page,rotateApiKey,apiKey,preflight};
