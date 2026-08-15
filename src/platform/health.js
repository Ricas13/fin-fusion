'use strict';
const express=require('express');
const fs=require('fs');
const path=require('path');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const operationsSettings=require('./operations-settings');
const IS_PRODUCTION=String(process.env.NODE_ENV||'').toLowerCase()==='production';
function latestMigration(){try{const dir=path.join(__dirname,'..','..','db','migrations');return fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort().at(-1)||null}catch{return null}}
function validPublicOrigin(value){try{const url=new URL(String(value||''));return url.protocol==='https:'&&Boolean(url.hostname)&&url.pathname.replace(/\/+$/,'')===''}catch{return false}}
async function readiness(){const checks={database:false,migrations:false,runtimeSettings:false,publicOrigin:!IS_PRODUCTION};let detail={};try{await query('SELECT 1');checks.database=true}catch(e){detail.database=e.message}if(checks.database){try{const expected=latestMigration(),r=await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1'),applied=r.rows[0]?.filename||null;checks.migrations=Boolean(expected&&applied===expected);detail.migrations={expected,applied}}catch(e){detail.migrations={error:e.message}}try{const ops=await operationsSettings.get();checks.publicOrigin=!IS_PRODUCTION||validPublicOrigin(ops.publicBaseUrl);if(!checks.publicOrigin)detail.publicOrigin='Production requires a canonical HTTPS public base URL.'}catch(e){detail.publicOrigin=e.message}}try{await runtimeSettings.ensureLoaded();checks.runtimeSettings=true}catch(e){detail.runtimeSettings=e.message}return{ok:Object.values(checks).every(Boolean),checks,detail}}
function publicResult(result){return{ok:Boolean(result.ok),checks:{database:Boolean(result.checks?.database),migrations:Boolean(result.checks?.migrations),runtimeSettings:Boolean(result.checks?.runtimeSettings),publicOrigin:Boolean(result.checks?.publicOrigin)}}}
function createHealthRouter(){const r=express.Router();r.get('/health/live',(_req,res)=>res.status(200).json({ok:true,service:'steam-fusion',process:'web'}));r.get('/health/ready',async(_req,res)=>{const result=await readiness();return res.status(result.ok?200:503).json(publicResult(result))});return r}
module.exports={createHealthRouter,readiness,latestMigration,publicResult,validPublicOrigin};
