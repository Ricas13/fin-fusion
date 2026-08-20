'use strict';

const express=require('express');
const {query}=require('../db');
const routeRateLimit=require('../security/route-rate-limit');
const operations=require('../platform/operations-settings');
const entitlements=require('./entitlements');
const jellyfin=require('./jellyfin-runtime');
const sourceAdmission=require('./source-admission');
const managedRuntime=require('./managed-runtime');
const managedSessions=require('./managed-session-reconciler');
const managedPlayback=require('./managed-playback-lifecycle');
const externalRuntime=require('./external-direct-runtime');
const runtimeSettings=require('./runtime-settings');

const manifestLimit=routeRateLimit.middleware({scope:'stremio-manifest',max:60,windowSeconds:60});
const streamLimit=routeRateLimit.middleware({scope:'stremio-stream',max:240,windowSeconds:60});
const playbackLimit=routeRateLimit.middleware({scope:'stremio-playback-control',max:1200,windowSeconds:60});
function enabled(){return runtimeSettings.enabled();}
function cors(_req,res,next){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range');res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.setHeader('Cache-Control','no-store');next();}
async function loadRuntimeSetting(_req,res,next){try{await runtimeSettings.ensureLoaded();return next();}catch(error){console.error('Stremio runtime setting unavailable:',error.message);return res.status(503).json({error:'Temporarily unavailable'});}}
function manifest(){return{id:'cc.captainfin.jellyfin',version:'1.3.0',name:'CAPTAiNFiN',description:'Stream results included with your CAPTAiNFiN subscription.',resources:[{name:'stream',types:['movie','series'],idPrefixes:['tt']}],types:['movie','series'],catalogs:[],behaviorHints:{configurable:false,p2p:false}};}
async function publicOrigin(req){try{const cfg=await operations.get();if(cfg.publicBaseUrl)return String(cfg.publicBaseUrl).replace(/\/$/,'');}catch(_error){}const host=req.get('x-forwarded-host')||req.get('host');const proto=req.get('x-forwarded-proto')||req.protocol||'https';return `${proto}://${host}`.replace(/\/$/,'');}
async function hasExplicitSources(entitlement){const r=await query(`SELECT EXISTS(SELECT 1 FROM subscriptions s JOIN plan_stremio_sources ps ON ps.plan_id=s.plan_id AND ps.enabled=TRUE WHERE s.id=$1) yes`,[entitlement.subscription_id]);return r.rows[0]?.yes===true;}
function attachLease(streams,lease=sourceAdmission.issue()){return streams.map(stream=>{try{const url=new URL(stream.url);if(/\/stremio\/[^/]+\/play\//.test(url.pathname))url.searchParams.set('lease',lease);return{...stream,url:url.toString()};}catch{return stream;}});}
async function managedMapping(entitlementId,mappingId){
  const result=await query(`SELECT sma.*,js.name server_name,js.base_url,js.public_url,js.enabled server_enabled,js.stremio_enabled,
      ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled
    FROM stremio_managed_accounts sma
    JOIN jellyfin_servers js ON js.id=sma.server_id
    JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
    WHERE sma.id=$2 AND sma.entitlement_id=$1 AND sma.status='active' AND js.enabled=TRUE AND js.stremio_enabled=TRUE AND ja.disabled=FALSE`,[entitlementId,mappingId]);
  return result.rows[0]||null;
}
function settledStreams(result,label){
  if(result.status==='fulfilled')return Array.isArray(result.value)?result.value:[];
  console.error(`Stremio ${label} source resolution failed:`,String(result.reason?.message||result.reason).slice(0,500));
  return[];
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
      const managedDelivery={proxyBase:origin,installToken:req.params.token};
      const [managedResult,externalResult]=await Promise.allSettled([
        managedRuntime.streamsFor(e,type,videoId,managedDelivery),
        externalRuntime.streamsFor(e,type,videoId)
      ]);
      const managed=settledStreams(managedResult,'managed'),external=settledStreams(externalResult,'external');
      const streams=[...managed,...external];
      await entitlements.markUse(e.id,'stream').catch(error=>console.warn('Unable to update Stremio usage timestamp:',error.message));
      return res.json({streams});
    }catch(error){console.error('Stremio stream request failed before source resolution:',String(error?.message||error).slice(0,500));return res.json({streams:[]});}
  });

  // Managed playback is a control-plane hop only. CAPTAiNFiN re-runs
  // PlaybackInfo for the selected source, enforces the managed stream limit,
  // registers the Jellyfin playback lifecycle and then redirects Stremio to
  // Jellyfin. Media bytes never pass through CAPTAiNFiN.
  router.get('/stremio/:token/play/:mappingId/:itemId/:mediaSourceId',playbackLimit,async(req,res)=>{
    if(!enabled())return res.status(404).end();const lease=String(req.query.lease||'');let e=null,admitted=false;
    try{
      e=await entitlements.findByInstallToken(req.params.token);if(!e||!lease)return res.status(404).end();
      const mapping=await managedMapping(e.id,req.params.mappingId);if(!mapping)return res.status(404).end();
      const playback=await managedRuntime.playbackInfo(mapping,req.params.itemId,req.params.mediaSourceId),source=managedRuntime.mediaSource(playback,req.params.mediaSourceId);if(!source)return res.status(404).end();
      const playMethod=managedRuntime.playMethodFor(source),playSessionId=String(playback?.PlaySessionId||req.query.playSessionId||'');if(!playMethod)return res.status(502).end();
      const id=managedPlayback.deviceId(lease),admission=await sourceAdmission.admit(e,lease,null,req.params.itemId,{managedMappingId:mapping.id,serverId:mapping.server_id,jellyfinUserId:mapping.jellyfin_user_id,deviceId:id,playSessionId,mediaSourceId:req.params.mediaSourceId,playMethod});
      if(!admission.allowed){res.setHeader('Retry-After','60');return res.status(429).end();}admitted=true;
      const started=await managedPlayback.start(mapping,lease,{itemId:req.params.itemId,mediaSourceId:req.params.mediaSourceId,playSessionId,playMethod});
      const target=managedRuntime.playbackUrl(mapping,req.params.itemId,source,playback,{accessToken:started.accessToken,deviceId:started.deviceId});
      await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES(NULL,'stremio.managed_playback.admitted','stremio_entitlement',$1,$2::jsonb)`,[e.id,JSON.stringify({serverId:mapping.server_id,jellyfinSessionId:started.jellyfinSessionId||null,playMethod:target.playMethod,active:admission.active,limit:admission.limit})]).catch(()=>{});
      return res.redirect(307,target.url);
    }catch(error){if(admitted&&e&&lease)await sourceAdmission.release(e.id,lease).catch(()=>{});console.error('Managed Stremio admission failed:',String(error?.message||error).slice(0,300));return res.status(502).end();}
  });

  // Retired byte-proxy URLs deliberately fail closed. Current managed results
  // use /play/... control-plane redirects and external fallback results point
  // directly at their Jellyfin server.
  const retiredPlayback=(_req,res)=>res.status(410).end();
  router.get('/stremio/:token/jellyfin/:itemId/:mediaSourceId',playbackLimit,retiredPlayback);
  router.get('/stremio/:token/source/:sourceId/:itemId/:mediaSourceId',playbackLimit,retiredPlayback);
  return router;
}

module.exports={available:true,enabled,manifest,publicOrigin,hasExplicitSources,attachLease,managedMapping,settledStreams,createStremioRuntimeRouter};
