'use strict';

const express=require('express');
const {query}=require('../db');
const routeRateLimit=require('../security/route-rate-limit');
const operations=require('../platform/operations-settings');
const entitlements=require('./entitlements');
const jellyfin=require('./jellyfin-runtime');
const planExternalSources=require('./plan-external-sources');
const sourcePlayback=require('./source-playback');
const sourceAdmission=require('./source-admission');
const managedRuntime=require('./managed-runtime');
const managedSessions=require('./managed-session-reconciler');
const managedPlayback=require('./managed-playback-lifecycle');
const externalRuntime=require('./external-direct-runtime');
const runtimeSettings=require('./runtime-settings');

const manifestLimit=routeRateLimit.middleware({scope:'stremio-manifest',max:60,windowSeconds:60});
const streamLimit=routeRateLimit.middleware({scope:'stremio-stream',max:240,windowSeconds:60});
const playbackLimit=routeRateLimit.middleware({scope:'stremio-source-playback',max:1200,windowSeconds:60});
function enabled(){return runtimeSettings.enabled();}
function cors(_req,res,next){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range');res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.setHeader('Cache-Control','no-store');next();}
async function loadRuntimeSetting(_req,res,next){try{await runtimeSettings.ensureLoaded();return next();}catch(error){console.error('Stremio runtime setting unavailable:',error.message);return res.status(503).json({error:'Temporarily unavailable'});}}
function manifest(){return{id:'cc.captainfin.jellyfin',version:'1.3.0',name:'CAPTAiNFiN',description:'Stream results included with your CAPTAiNFiN subscription.',resources:[{name:'stream',types:['movie','series'],idPrefixes:['tt']}],types:['movie','series'],catalogs:[],behaviorHints:{configurable:false,p2p:false}};}
async function publicOrigin(req){try{const cfg=await operations.get();if(cfg.publicBaseUrl)return String(cfg.publicBaseUrl).replace(/\/$/,'');}catch(_error){}const host=req.get('x-forwarded-host')||req.get('host');const proto=req.get('x-forwarded-proto')||req.protocol||'https';return `${proto}://${host}`.replace(/\/$/,'');}
function copyPlaybackHeaders(upstream,res){for(const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified','cache-control']){const value=upstream.headers?.[name];if(value!=null)res.setHeader(name,value);}}
async function hasExplicitSources(entitlement){const r=await query(`SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN plan_stremio_sources ps ON ps.plan_id=s.plan_id AND ps.enabled=TRUE WHERE s.id=$1) yes`,[entitlement.subscription_id]);return r.rows[0]?.yes===true;}
function attachLease(streams,lease=sourceAdmission.issue()){return streams.map(stream=>{try{const url=new URL(stream.url);if(/\/stremio\/[^/]+\/(?:source|jellyfin)\//.test(url.pathname))url.searchParams.set('lease',lease);return{...stream,url:url.toString()};}catch{return stream;}});}
async function managedMapping(entitlementId,mappingId){
  const result=await query(`SELECT sma.*,js.name server_name,js.base_url,js.public_url,js.enabled server_enabled,js.stremio_enabled,
      ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled
    FROM stremio_managed_accounts sma
    JOIN jellyfin_servers js ON js.id=sma.server_id
    JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
    WHERE sma.id=$2 AND sma.entitlement_id=$1 AND sma.status='active' AND js.enabled=TRUE AND js.stremio_enabled=TRUE AND ja.disabled=FALSE`,[entitlementId,mappingId]);
  return result.rows[0]||null;
}

function pipePlayback(opened,res,{onUnauthorized=null,onFinished=null}={}){
  const upstream=opened.response,status=Number(upstream.statusCode||502);
  if(status===401||status===403){onUnauthorized?.();onFinished?.();upstream.destroy();res.status(502).end();return false;}
  if(status<200||status>=400){onFinished?.();upstream.destroy();res.status(502).end();return false;}
  copyPlaybackHeaders(upstream,res);res.status(status);
  if(opened.method==='HEAD'){upstream.resume();res.end();onFinished?.();return true;}
  upstream.on('error',()=>{onFinished?.();if(!res.headersSent)res.status(502);res.end();});
  upstream.on('end',()=>onFinished?.());
  res.on('close',()=>{onFinished?.();if(!res.writableEnded)opened?.request?.destroy();});
  upstream.pipe(res);return true;
}

function createStremioRuntimeRouter(){
  const router=express.Router();router.use('/stremio',cors,loadRuntimeSetting);router.options('/stremio/*',(_req,res)=>res.sendStatus(204));
  jellyfin.startStreamManager({intervalMs:60000});
  managedSessions.start({intervalMs:15000});
  managedPlayback.startManager({intervalMs:15000});
  router.get('/stremio/:token/manifest.json',manifestLimit,async(req,res)=>{
    if(!enabled())return res.status(404).json({error:'Not found'});
    try{const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.status(404).json({error:'Not found'});await entitlements.markUse(e.id,'manifest');return res.json(manifest());}
    catch(_error){console.error('Stremio manifest request failed.');return res.status(503).json({error:'Temporarily unavailable'});}
  });
  router.get('/stremio/:token/stream/:type/:videoId.json',streamLimit,async(req,res)=>{
    if(!enabled())return res.json({streams:[]});
    try{
      const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.json({streams:[]});
      const type=String(req.params.type||''),videoId=String(req.params.videoId||''),origin=await publicOrigin(req);
      const [managed,external]=await Promise.all([
        managedRuntime.streamsFor(e,type,videoId,{proxyBase:origin,installToken:req.params.token}),
        externalRuntime.streamsFor(e,type,videoId)
      ]);
      const streams=[...managed,...external];
      await entitlements.markUse(e.id,'stream');return res.json({streams});
    }catch(error){console.error('Stremio stream request failed:',String(error?.message||error).slice(0,300));return res.json({streams:[]});}
  });

  // Managed playback admission is intentionally a tiny control-plane hop.
  // CAPTAiNFiN checks the stream allowance and registers Jellyfin playback,
  // then redirects the player to Jellyfin. No media bytes pass through here.
  router.get('/stremio/:token/play/:mappingId/:itemId/:mediaSourceId',playbackLimit,async(req,res)=>{
    if(!enabled())return res.status(404).end();const lease=String(req.query.lease||''),playSessionId=String(req.query.playSessionId||'');let e=null,admitted=false;
    try{
      e=await entitlements.findByInstallToken(req.params.token);if(!e||!lease)return res.status(404).end();
      const mapping=await managedMapping(e.id,req.params.mappingId);if(!mapping)return res.status(404).end();
      const id=managedPlayback.deviceId(lease),admission=await sourceAdmission.admit(e,lease,null,req.params.itemId,{managedMappingId:mapping.id,serverId:mapping.server_id,jellyfinUserId:mapping.jellyfin_user_id,deviceId:id,playSessionId,mediaSourceId:req.params.mediaSourceId});
      if(!admission.allowed){res.setHeader('Retry-After','60');return res.status(429).end();}admitted=true;
      const started=await managedPlayback.start(mapping,lease,{itemId:req.params.itemId,mediaSourceId:req.params.mediaSourceId,playSessionId});
      const target=managedRuntime.directUrl(mapping,req.params.itemId,req.params.mediaSourceId,playSessionId,started.deviceId,started.accessToken);
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES(NULL,'stremio.managed_playback.admitted','stremio_entitlement',$1,$2::jsonb)`,[e.id,JSON.stringify({serverId:mapping.server_id,jellyfinSessionId:started.jellyfinSessionId||null,active:admission.active,limit:admission.limit})]).catch(()=>{});
      return res.redirect(302,target);
    }catch(error){if(admitted&&e&&lease)await sourceAdmission.release(e.id,lease).catch(()=>{});console.error('Managed Stremio admission failed:',String(error?.message||error).slice(0,300));return res.status(502).end();}
  });

  // Compatibility-only proxy routes for cached stream URLs from the previous
  // runtime. External compatibility URLs are still checked against the plan's
  // explicit external-source selection before any bytes are proxied.
  router.get('/stremio/:token/jellyfin/:itemId/:mediaSourceId',playbackLimit,async(req,res)=>{
    if(!enabled())return res.status(404).end();let opened=null,heartbeat=null,e=null,admitted=false,released=false;const lease=String(req.query.lease||''),isHead=req.method==='HEAD';
    const stop=()=>{if(heartbeat){clearInterval(heartbeat);heartbeat=null;}};
    const releaseSoon=()=>{stop();if(!released&&admitted&&e&&lease){released=true;setTimeout(()=>sourceAdmission.release(e.id,lease).catch(()=>{}),5000).unref?.();}};
    try{
      e=await entitlements.findByInstallToken(req.params.token);if(!e||!e.jellyfin_account_id||!e.server_id||!lease)return res.status(404).end();
      if(!isHead){const admission=await sourceAdmission.admit(e,lease,null,req.params.itemId);if(!admission.allowed){res.setHeader('Retry-After','60');return res.status(429).end();}admitted=true;}
      opened=await jellyfin.openPlayback(e,req.params.itemId,req.params.mediaSourceId,req.get('range')||'',isHead?'HEAD':'GET');
      if(!isHead){heartbeat=setInterval(()=>sourceAdmission.touch(e.id,lease).catch(()=>{}),60000);heartbeat.unref?.();}
      return pipePlayback(opened,res,{onUnauthorized:()=>query(`UPDATE stremio_entitlements SET last_error='Managed Jellyfin authentication expired. Reissue the Stremio installation to rotate playback access.',updated_at=NOW() WHERE id=$1`,[e.id]).catch(()=>{}),onFinished:releaseSoon});
    }catch(_error){stop();opened?.request?.destroy();if(admitted&&e&&lease)await sourceAdmission.release(e.id,lease).catch(()=>{});if(!res.headersSent)return res.status(502).end();return res.end();}
  });
  router.get('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId',playbackLimit,async(req,res)=>{
    if(!enabled())return res.status(404).end();let opened,heartbeat=null,e=null,lease=String(req.query.lease||''),admitted=false;const isHead=req.method==='HEAD';
    try{
      e=await entitlements.findByInstallToken(req.params.token);if(!e||!lease)return res.status(404).end();
      const source=await planExternalSources.authorized(e,req.params.sourceId);if(!source)return res.status(404).end();
      if(!isHead){const admission=await sourceAdmission.admit(e,lease,source.id,req.params.itemId);if(!admission.allowed){res.setHeader('Retry-After','60');return res.status(429).end();}admitted=true;}
      opened=await sourcePlayback.open(source,req.params.itemId,req.params.mediaSourceId,req.get('range')||'',isHead?'HEAD':'GET');
      const upstream=opened.response,status=Number(upstream.statusCode||502);
      if(status===401||status===403){if(admitted)await sourceAdmission.release(e.id,lease).catch(()=>{});await query(`UPDATE stremio_sources SET auth_state='reconnect_required',last_error='Jellyfin authentication expired. Reconnect this Stremio source.',updated_at=NOW() WHERE id=$1`,[source.id]).catch(()=>{});upstream.destroy();return res.status(502).end();}
      if(status<200||status>=400){if(admitted)await sourceAdmission.release(e.id,lease).catch(()=>{});upstream.destroy();return res.status(502).end();}
      copyPlaybackHeaders(upstream,res);res.status(status);
      if(isHead){upstream.resume();return res.end();}
      heartbeat=setInterval(()=>sourceAdmission.touch(e.id,lease).catch(()=>{}),60000);heartbeat.unref?.();
      const stop=()=>{if(heartbeat){clearInterval(heartbeat);heartbeat=null;}};
      const releaseSoon=()=>{if(admitted&&e&&lease)setTimeout(()=>sourceAdmission.release(e.id,lease).catch(()=>{}),5000).unref?.();};
      upstream.on('error',()=>{stop();releaseSoon();if(!res.headersSent)res.status(502);res.end();});
      upstream.on('end',()=>{stop();releaseSoon();});
      res.on('close',()=>{stop();releaseSoon();if(!res.writableEnded)opened?.request?.destroy();});
      upstream.pipe(res);
    }catch(_error){if(heartbeat)clearInterval(heartbeat);opened?.request?.destroy();if(admitted&&e&&lease)await sourceAdmission.release(e.id,lease).catch(()=>{});if(!res.headersSent)return res.status(502).end();return res.end();}
  });
  return router;
}

module.exports={available:true,enabled,manifest,publicOrigin,hasExplicitSources,attachLease,managedMapping,copyPlaybackHeaders,pipePlayback,createStremioRuntimeRouter};
