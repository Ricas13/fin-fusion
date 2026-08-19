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
  const sourceState=server.stremio_enabled?pill('Enabled','good'):pill('Not used','');
  const readiness=!server.api_configured?pill('API key required','bad'):!playable?pill('Public URL required','bad'):healthy?pill('Ready','good'):pill(server.health_status||'unknown','warn');
  const accounts=Number(server.managed_stremio_accounts||0);
  return `<form class="managedSourceCard" method="post" action="/admin/servers/stremio/managed/${esc(server.id)}" autocomplete="off">${token(req)}
    <div class="managedIdentity"><div class="managedTitle"><strong>${esc(server.name)}</strong>${readiness}</div><div class="subText">${esc(server.server_class)}${server.public_url?` · ${esc(server.public_url)}`:''}</div><div class="managedMeta">${sourceState}<span class="subText">${accounts} hidden account${accounts===1?'':'s'}</span></div></div>
    <div class="managedControls"><label class="checkRow managedToggle"><input type="checkbox" name="enabled" value="1" ${server.stremio_enabled?'checked':''}><span>Use for Stremio</span></label><label class="managedPriority"><span>Priority</span><input class="input" type="number" min="1" max="10000" name="priority" value="${Number(server.stremio_priority||100)}"></label></div>
    <div class="managedActions"><button class="button secondary btn-sm">Save</button><a class="button secondary btn-sm" href="/admin/servers/${esc(server.id)}/edit">Server settings</a></div>
    <details class="managedCredential"><summary>API credential · ${server.api_configured?'configured':'required'}</summary><div class="managedCredentialInner"><label><span>Jellyfin API key</span><input class="input" type="password" name="apiKey" minlength="16" maxlength="256" autocomplete="new-password" placeholder="${server.api_configured?'Configured — leave blank to keep':'Paste API key'}"></label><div class="subText">Write-only. Leave blank to keep the current key. CAPTAiNFiN validates any replacement against Jellyfin before storing it encrypted.</div></div></details>
  </form>`;
}

async function page(req){
  await runtimeSettings.ensureLoaded();
  const servers=await managed.list(),enabled=servers.filter(s=>s.stremio_enabled).length;
  const body=`${notice(req)}<div class="statusBanner"><strong>Managed Stremio stays private.</strong> Customers never see server names or source type. CAPTAiNFiN keeps administrator API credentials backend-only and uses restricted hidden Jellyfin identities for playback.</div><section class="section managedSection"><div class="sectionHead"><div><h2>Managed Jellyfin servers</h2><div class="muted">Choose which of your own servers feed Stremio first. Lower priority numbers appear first. ${enabled} currently enabled.</div></div>${pill(`${enabled}/${servers.length} enabled`,enabled?'good':'')}</div>${servers.length?`<div class="managedSourceList">${servers.map(s=>row(req,s)).join('')}</div>`:'<div class="empty">No Jellyfin servers are configured.</div>'}</section><style>
  .managedSection{overflow:hidden}.managedSourceList{display:grid}.managedSourceCard{display:grid;grid-template-columns:minmax(260px,1fr) minmax(250px,.8fr) auto;gap:14px;align-items:center;padding:14px 16px;border-top:1px solid var(--border,#293744)}.managedSourceCard:first-child{border-top:0}.managedIdentity{min-width:0}.managedTitle{display:flex;align-items:center;gap:9px;flex-wrap:wrap}.managedTitle strong{font-size:14px}.managedIdentity .subText{overflow-wrap:anywhere}.managedMeta{display:flex;align-items:center;gap:9px;margin-top:7px;flex-wrap:wrap}.managedControls{display:flex;align-items:center;gap:16px;flex-wrap:wrap}.managedToggle{display:flex!important;align-items:center;gap:8px;margin:0!important;white-space:nowrap}.managedPriority{display:flex;align-items:center;gap:8px;white-space:nowrap}.managedPriority .input{width:92px;min-width:92px}.managedActions{display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap}.managedCredential{grid-column:1/-1;margin-top:-2px;border-top:1px solid rgba(125,145,164,.18);padding-top:7px}.managedCredential summary{cursor:pointer;color:var(--text-muted,#9eacbb);font-size:12px;font-weight:700;list-style-position:inside}.managedCredentialInner{display:grid;grid-template-columns:minmax(280px,520px) minmax(240px,1fr);gap:12px;align-items:end;padding:10px 0 2px}.managedCredentialInner label{display:grid;gap:5px}.managedCredentialInner label span{font-size:12px;font-weight:700}@media(max-width:1050px){.managedSourceCard{grid-template-columns:1fr 1fr}.managedActions{justify-content:flex-start}.managedCredential{grid-column:1/-1}}@media(max-width:720px){.managedSourceCard{grid-template-columns:1fr}.managedControls{align-items:flex-start}.managedActions{justify-content:flex-start}.managedCredential{grid-column:1}.managedCredentialInner{grid-template-columns:1fr}}
  </style>`;
  return layout({siteName:runtimeSettings.siteName(),active:'stremio-managed-sources',title:'Manage Stremio',subtitle:'Your Jellyfin fleet as private CAPTAiNFiN-controlled Stremio sources',body});
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
