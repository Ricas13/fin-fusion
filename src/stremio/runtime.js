'use strict';

const express=require('express');
const routeRateLimit=require('../security/route-rate-limit');
const entitlements=require('./entitlements');
const jellyfin=require('./jellyfin-runtime');
const sourceRuntime=require('./source-runtime');
const sourceGateway=require('./source-gateway');

const manifestLimit=routeRateLimit.middleware({scope:'stremio-manifest',max:60,windowSeconds:60});
const streamLimit=routeRateLimit.middleware({scope:'stremio-stream',max:240,windowSeconds:60});
const gatewayLimit=routeRateLimit.middleware({scope:'stremio-gateway',max:1200,windowSeconds:60});
function enabled(){return String(process.env.STREMIO_RUNTIME_ENABLED||'').toLowerCase()==='true';}
function cors(_req,res,next){res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Methods','GET,HEAD,OPTIONS');res.setHeader('Access-Control-Allow-Headers','Content-Type,Range');res.setHeader('Cross-Origin-Resource-Policy','cross-origin');res.setHeader('Cache-Control','no-store');next();}
function manifest(){return{id:'cc.captainfin.jellyfin',version:'1.1.0',name:'CAPTaINFiN',description:'Your CAPTaINFiN subscription streams through Stremio.',resources:[{name:'stream',types:['movie','series'],idPrefixes:['tt']}],types:['movie','series'],catalogs:[],behaviorHints:{configurable:false,p2p:false}};}
function createStremioRuntimeRouter(){const router=express.Router();router.use('/stremio',cors);router.options('/stremio/*',(_req,res)=>res.sendStatus(204));const gatewayHandler=async(req,res)=>{if(!enabled())return res.status(404).end();try{return await sourceGateway.proxy(req,res);}catch(error){console.warn('Stremio pooled gateway failed:',error.message);if(!res.headersSent)return res.status(502).end();return res.destroy(error);}};router.get('/stremio/media/:grant/:filename',gatewayLimit,gatewayHandler);router.head('/stremio/media/:grant/:filename',gatewayLimit,gatewayHandler);router.get('/stremio/:token/manifest.json',manifestLimit,async(req,res)=>{if(!enabled())return res.status(404).json({error:'Not found'});try{const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.status(404).json({error:'Not found'});await entitlements.markUse(e.id,'manifest');return res.json(manifest());}catch(_error){console.error('Stremio manifest request failed.');return res.status(503).json({error:'Temporarily unavailable'});}});router.get('/stremio/:token/stream/:type/:videoId.json',streamLimit,async(req,res)=>{if(!enabled())return res.json({streams:[]});try{const e=await entitlements.findByInstallToken(req.params.token);if(!e)return res.json({streams:[]});let streams=await sourceRuntime.streamsFor(e,String(req.params.type||''),String(req.params.videoId||''));if(streams===null)streams=await jellyfin.streamsFor(e,String(req.params.type||''),String(req.params.videoId||''));await entitlements.markUse(e.id,'stream');return res.json({streams:streams||[]});}catch(_error){console.error('Stremio stream request failed.');return res.json({streams:[]});}});return router;}
module.exports={available:true,enabled,manifest,createStremioRuntimeRouter};
