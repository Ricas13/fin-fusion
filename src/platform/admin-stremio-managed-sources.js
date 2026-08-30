'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const {encryptWithEnv}=require('../security/purpose-crypto');
const registry=require('../jellyfin/registry');
const managed=require('../stremio/managed-sources');
const {probeCredentials}=require('./admin-servers');

const mutationLimit=routeRateLimit.middleware({scope:'admin-stremio-managed-sources',max:30,windowSeconds:300});
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function apiKey(value,type='jellyfin'){const key=String(value||'').trim();if(!key)return null;const label=registry.mediaProvider.label(type);if(key.length<16||key.length>256||/[\s\x00-\x1f\x7f]/.test(key))throw new Error(`${label} API key format is invalid.`);return key;}

async function rotateApiKey({serverId,value,actorUserId}){
  const server=await managed.get(serverId);if(!server)throw new Error('Media server not found.');
  const type=registry.mediaProvider.normalizeType(server.media_server_type),label=registry.mediaProvider.label(type),key=apiKey(value,type);if(!key)return false;
  await probeCredentials(server.base_url,key,type);
  await query(`UPDATE jellyfin_servers SET api_key_encrypted=$2,health_status='unknown',updated_at=NOW() WHERE id=$1`,[serverId,encryptWithEnv(key,'JELLYFIN_ENCRYPTION_KEY','jf1')]);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.stremio.managed_source.api_key.rotate','jellyfin_server',$2,$3::jsonb)`,[actorUserId,serverId,JSON.stringify({credentialRotated:true,mediaServerType:type})]);
  return{rotated:true,label};
}
async function preflight(serverId,enabled,priorityValue){
  const sourcePriority=managed.priority(priorityValue||100),server=await managed.get(serverId);
  if(!server)throw new Error('Media server not found.');
  const label=registry.mediaProvider.label(server.media_server_type);
  if(enabled&&!server.enabled)throw new Error(`Enable the ${label} server before enabling it for Stremio.`);
  if(enabled&&!server.public_url)throw new Error(`A public ${label} URL is required for direct Stremio playback.`);
  return{server,sourcePriority,label};
}

function createAdminStremioManagedSourcesRouter(){
  const router=express.Router();
  router.use('/admin/servers/stremio/managed',gate,noStore);
  router.get('/admin/servers/stremio/managed',(_req,res)=>res.redirect(302,'/admin/servers/stremio'));
  router.post('/admin/servers/stremio/managed/:serverId',mutationLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid or expired security token');
    try{
      const enabled=req.body.enabled==='1',checked=await preflight(req.params.serverId,enabled,req.body.priority);
      const rotation=await rotateApiKey({serverId:req.params.serverId,value:req.body.apiKey,actorUserId:req.session.authUserId});
      await managed.configure({serverId:req.params.serverId,enabled,sourcePriority:checked.sourcePriority,actorUserId:req.session.authUserId});
      const message=`Managed Stremio source ${enabled?'enabled':'disabled'}.${rotation?` ${rotation.label} API key rotated.`:''}`;
      return res.redirect('/admin/servers/stremio?message='+encodeURIComponent(message));
    }catch(error){return res.redirect('/admin/servers/stremio?error='+encodeURIComponent(error.message));}
  });
  return router;
}

module.exports={createAdminStremioManagedSourcesRouter,rotateApiKey,apiKey,preflight};
