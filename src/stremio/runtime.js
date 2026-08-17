'use strict';

const express=require('express');
const routeRateLimit=require('../security/route-rate-limit');
const entitlements=require('./entitlements');
const jellyfin=require('./jellyfin-runtime');
const sourcePool=require('./source-pool');
const runtimeSettings=require('./runtime-settings');

const manifestLimit=routeRateLimit.middleware({scope:'stremio-manifest',max:60,windowSeconds:60});
const streamLimit=routeRateLimit.middleware({scope:'stremio-stream',max:240,windowSeconds:60});
function enabled(){return runtimeSettings.enabled();}
function cors(_req,res,next){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type');res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.setHeader('Cache-Control','no-store');next();}
async function loadRuntimeSetting(_req,res,next){try{await runtimeSettings.ensureLoaded();return next();}catch(error){console.error('Stremio runtime setting unavailable:',error.message);return res.status(503).json({error:'Temporarily unavailable'});}}
function manifest(){return{id:'cc.captainfin.jellyfin',version:'1.1.0',name:'CAPTAiNFiN',description:'Your CAPTAiNFiN subscription streams through authorized Jellyfin sources.',resources:[{name:'stream',types:['movie','series'],idPrefixes:['tt']}],types:['movie','series'],catalogs:[],behaviorHints:{configurable:false,p2p:false}};}

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
      const type=String(req.params.type||''),videoId=String(req.params.videoId||'');
      let streams=await sourcePool.streamsFor(e,type,videoId);
      if(!streams.length)streams=await jellyfin.streamsFor(e,type,videoId);
      await entitlements.markUse(e.id,'stream');return res.json({streams});
    }catch(_error){console.error('Stremio stream request failed.');return res.json({streams:[]});}
  });
  return router;
}

module.exports={available:true,enabled,manifest,createStremioRuntimeRouter};
