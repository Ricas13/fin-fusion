'use strict';

const express=require('express');
const {query}=require('../db');
const routeRateLimit=require('../security/route-rate-limit');
const operations=require('../platform/operations-settings');
const entitlements=require('./entitlements');
const jellyfin=require('./jellyfin-runtime');
const sourcePool=require('./source-pool');
const sourcePlayback=require('./source-playback');
const runtimeSettings=require('./runtime-settings');

const manifestLimit=routeRateLimit.middleware({scope:'stremio-manifest',max:60,windowSeconds:60});
const streamLimit=routeRateLimit.middleware({scope:'stremio-stream',max:240,windowSeconds:60});
const playbackLimit=routeRateLimit.middleware({scope:'stremio-source-playback',max:1200,windowSeconds:60});
function enabled(){return runtimeSettings.enabled();}
function cors(_req,res,next){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range');res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.setHeader('Cache-Control','no-store');next();}
async function loadRuntimeSetting(_req,res,next){try{await runtimeSettings.ensureLoaded();return next();}catch(error){console.error('Stremio runtime setting unavailable:',error.message);return res.status(503).json({error:'Temporarily unavailable'});}}
function manifest(){return{id:'cc.captainfin.jellyfin',version:'1.1.0',name:'CAPTAiNFiN',description:'Your CAPTAiNFiN subscription streams through authorized Jellyfin sources.',resources:[{name:'stream',types:['movie','series'],idPrefixes:['tt']}],types:['movie','series'],catalogs:[],behaviorHints:{configurable:false,p2p:false}};}
async function publicOrigin(req){try{const cfg=await operations.get();if(cfg.publicBaseUrl)return String(cfg.publicBaseUrl).replace(/\/$/,'');}catch(_error){}const host=req.get('x-forwarded-host')||req.get('host');const proto=req.get('x-forwarded-proto')||req.protocol||'https';return `${proto}://${host}`.replace(/\/$/,'');}
function copyPlaybackHeaders(upstream,res){for(const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified','cache-control']){const value=upstream.headers?.[name];if(value!=null)res.setHeader(name,value);}}
async function hasExplicitSources(entitlement){const r=await query(`SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN plan_stremio_sources ps ON ps.plan_id=s.plan_id AND ps.enabled=TRUE WHERE s.id=$1) yes`,[entitlement.subscription_id]);return r.rows[0]?.yes===true;}

function createStremioRuntimeRouter(){
  const router=express.Router();router.use('/stremio',cors,loadRuntimeSetting);router.options('/stremio/*',(_req,res)=>res.sendStatus(204));
  router.get('/stremio/:token/manifest.json',manifestLimit,async(req,res)=>{
    if(!enabled())return res.status(404).json({error:'Not found'});
    try{const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.status(404).json({error:'Not found'});await entitlements.markUse(e.id,'manifest');return res.json(manifest());}
    catch(_error){console.error('Stremio manifest request failed.');return res.status(503).json({error:'Temporarily unavailable'});}
  });
  router.get('/stremio/:token/stream/:type/:videoId.json',streamLimit,async(req,res)=>{
    if(!enabled())return res.json({streams:[]});
    try{
      const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.json({streams:[]});
      const type=String(req.params.type||''),videoId=String(req.params.videoId||''),proxyBase=await publicOrigin(req),explicit=await hasExplicitSources(e);
      let streams=await sourcePool.streamsFor(e,type,videoId,{proxyBase,installToken:req.params.token});
      if(!streams.length&&!explicit)streams=await jellyfin.streamsFor(e,type,videoId);
      await entitlements.markUse(e.id,'stream');return res.json({streams});
    }catch(_error){console.error('Stremio stream request failed.');return res.json({streams:[]});}
  });
  router.get('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId',playbackLimit,async(req,res)=>{
    if(!enabled())return res.status(404).end();let opened;
    try{
      const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.status(404).end();
      const source=await sourcePool.authorizedSourceForEntitlement(e,req.params.sourceId);if(!source)return res.status(404).end();
      opened=await sourcePlayback.open(source,req.params.itemId,req.params.mediaSourceId,req.get('range')||'');
      const upstream=opened.response,status=Number(upstream.statusCode||502);
      if(status===401||status===403){await query(`UPDATE stremio_sources SET auth_state='reconnect_required',last_error='Jellyfin authentication expired. Reconnect this Stremio source.',updated_at=NOW() WHERE id=$1`,[source.id]).catch(()=>{});upstream.destroy();return res.status(502).end();}
      if(status<200||status>=400){upstream.destroy();return res.status(502).end();}
      copyPlaybackHeaders(upstream,res);res.status(status);
      upstream.on('error',()=>{if(!res.headersSent)res.status(502);res.end();});
      res.on('close',()=>{if(!res.writableEnded)opened?.request?.destroy();});
      upstream.pipe(res);
    }catch(_error){opened?.request?.destroy();if(!res.headersSent)return res.status(502).end();return res.end();}
  });
  return router;
}

module.exports={available:true,enabled,manifest,publicOrigin,hasExplicitSources,createStremioRuntimeRouter};
