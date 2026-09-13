'use strict';
const express=require('express');
const fs=require('fs');
const path=require('path');
const {query,poolStats}=require('../db');
const runtimeSettings=require('./runtime-settings');
const operationsSettings=require('./operations-settings');
const IS_PRODUCTION=String(process.env.NODE_ENV||'').toLowerCase()==='production';
function boundedReadinessTimeout(value=process.env.READINESS_TIMEOUT_MS){const parsed=Number(value);if(!Number.isFinite(parsed)||parsed<=0)return 6000;return Math.max(1000,Math.min(15000,Math.floor(parsed)))}
const READINESS_TIMEOUT_MS=boundedReadinessTimeout();
function latestMigration(){try{const dir=path.join(__dirname,'..','..','db','migrations');return fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort().at(-1)||null}catch{return null}}
function validPublicOrigin(value){try{const url=new URL(String(value||''));return url.protocol==='https:'&&Boolean(url.hostname)&&url.pathname.replace(/\/+$/,'')===''}catch{return false}}
async function readinessChecks(){
 const checks={database:false,databasePool:false,migrations:false,runtimeSettings:false,publicOrigin:!IS_PRODUCTION};let detail={};
 try{await query('SELECT 1');checks.database=true}catch(e){detail.database=e.message}
 const pool=poolStats();
 checks.databasePool=!pool.overloaded;
 detail.databasePool=pool;
 if(checks.database){
  try{const expected=latestMigration(),r=await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1'),applied=r.rows[0]?.filename||null;checks.migrations=Boolean(expected&&applied===expected);detail.migrations={expected,applied}}catch(e){detail.migrations={error:e.message}}
  try{const ops=await operationsSettings.get();checks.publicOrigin=!IS_PRODUCTION||validPublicOrigin(ops.publicBaseUrl);if(!checks.publicOrigin)detail.publicOrigin='Production external links/OAuth require a canonical HTTPS public base URL.'}catch(e){detail.publicOrigin=e.message}
 }
 try{await runtimeSettings.ensureLoaded();checks.runtimeSettings=true}catch(e){detail.runtimeSettings=e.message}
 // Public origin is capability readiness, not process readiness. Missing it must
 // disable/degrade external-link features, but it must never remove the healthy
 // storefront from the reverse proxy. Database pool overload, however, means the
 // process cannot safely accept more revenue-facing work and must fail readiness
 // immediately instead of allowing a request queue avalanche.
 const ok=checks.database&&checks.databasePool&&checks.migrations&&checks.runtimeSettings;
 return{ok,degraded:ok&&!checks.publicOrigin,checks,detail,timedOut:false,pool};
}
function timeoutResult(){const pool=poolStats();return{ok:false,degraded:false,timedOut:true,checks:{database:false,databasePool:!pool.overloaded,migrations:false,runtimeSettings:false,publicOrigin:!IS_PRODUCTION},detail:{readiness:`Readiness exceeded ${READINESS_TIMEOUT_MS}ms.`,databasePool:pool},pool}}
async function readiness(){
 let timer;
 try{
  return await Promise.race([
   readinessChecks(),
   new Promise(resolve=>{timer=setTimeout(()=>resolve(timeoutResult()),READINESS_TIMEOUT_MS);timer.unref?.()})
  ]);
 }finally{if(timer)clearTimeout(timer)}
}
function publicResult(result){const pool=result.pool||result.detail?.databasePool||poolStats();return{ok:Boolean(result.ok),degraded:Boolean(result.degraded),timedOut:Boolean(result.timedOut),checks:{database:Boolean(result.checks?.database),databasePool:Boolean(result.checks?.databasePool),migrations:Boolean(result.checks?.migrations),runtimeSettings:Boolean(result.checks?.runtimeSettings),publicOrigin:Boolean(result.checks?.publicOrigin)},pool:{max:pool.max,total:pool.total,idle:pool.idle,waiting:pool.waiting,maxWaiting:pool.maxWaiting,saturated:Boolean(pool.saturated),overloaded:Boolean(pool.overloaded)}}}
function createHealthRouter(){const r=express.Router();r.get('/health/live',(_req,res)=>res.status(200).json({ok:true,service:'steam-fusion',process:'web'}));r.get('/health/ready',async(_req,res)=>{const result=await readiness();return res.status(result.ok?200:503).json(publicResult(result))});return r}
module.exports={createHealthRouter,readiness,readinessChecks,timeoutResult,latestMigration,publicResult,validPublicOrigin,boundedReadinessTimeout,READINESS_TIMEOUT_MS};
