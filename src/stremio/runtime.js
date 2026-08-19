'use strict';

const express=require('express');
const {query}=require('../db');
const routeRateLimit=require('../security/route-rate-limit');
const operations=require('../platform/operations-settings');
const entitlements=require('./entitlements');
const jellyfin=require('./jellyfin-runtime');
const sourcePool=require('./source-pool');
const sourcePlayback=require('./source-playback');
const sourceAdmission=require('./source-admission');
const managedRuntime=require('./managed-runtime');
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
  // Keep the legacy reconciler while cached/provisioned single-server installations
  // transition to the multi-managed-source model. New stream manifests do not use
  // either CAPTAiNFiN playback proxy route below.
  jellyfin.startStreamManager({intervalMs:60000});
  router.get('/stremio/:token/manifest.json',manifestLimit,async(req,res)=>{
    if(!enabled())return res.status(404).json({error:'Not found'});
    try{const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.status(404).json({error:'Not found'});await entitlements.markUse(e.id,'manifest');return res.json(manifest());}
    catch(_error){console.error('Stremio manifest request failed.');return res.status(503).json({error:'Temporarily unavailable'});}
  });
  router.get('/stremio/:token/stream/:type/:videoId.json',streamLimit,async(req,res)=>{
    if(!enabled())return res.json({streams:[]});
    try{
      const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.json({streams:[]});
      const type=String(req.params.type||''),videoId=String(req.params.videoId||'');
      // Resolve both classes concurrently for latency, then deliberately flatten
      // managed fleet results first. Source type/name is never added to customer
      // stream labels or descriptions.
      const [managed,external]=await Promise.all([
        managedRuntime.streamsFor(e,type,videoId),
        externalRuntime.streamsFor(e,type,videoId)
      ]);
      const streams=[...managed,...external];
      await entitlements.markUse(e.id,'stream');return res.json({streams});
    }catch(error){console.error('Stremio stream request failed:',String(error?.message||error).slice(0,300));return res.json({streams:[]});}
  });

  // Compatibility-only proxy routes for stream manifests cached before the direct
  // delivery migration. New manifests never point at these routes. They can be
  // removed after the compatibility window has elapsed.
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
      const source=await sourcePool.authorizedSourceForEntitlement(e,req.params.sourceId);if(!source)return res.status(404).end();
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

module.exports={available:true,enabled,manifest,publicOrigin,hasExplicitSources,attachLease,copyPlaybackHeaders,pipePlayback,createStremioRuntimeRouter};
