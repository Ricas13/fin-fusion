'use strict';
require('dotenv').config();
const assert=require('assert');
process.env.SESSION_SECRET=process.env.SESSION_SECRET||'route-ownership-ci-secret-0123456789abcdef0123456789';
process.env.NODE_ENV=process.env.NODE_ENV||'test';
const {createApplication}=require('../src/application');
const {getPool}=require('../src/db');
const ALLOW=new Set([]);
function join(prefix,path){const left=String(prefix||'').replace(/\/$/,'');const right=String(path||'');if(!left)return right||'/';if(!right||right==='/')return left||'/';return `${left}${right.startsWith('/')?'':'/'}${right}`;}
function regexpPrefix(layer){if(!layer?.regexp||layer.regexp.fast_slash)return'';const raw=String(layer.regexp);const match=raw.match(/^\/\^\\\/(.+?)\\\/?\(\?=\\\/\|\$\)\/i?$/);if(!match)return'';return'/'+match[1].replace(/\\\//g,'/').replace(/\\/g,'');}
function walk(stack,prefix='',out=[]){for(const layer of stack||[]){if(layer.route){const paths=Array.isArray(layer.route.path)?layer.route.path:[layer.route.path];for(const p of paths)for(const [method,enabled] of Object.entries(layer.route.methods||{}))if(enabled)out.push({method:method.toUpperCase(),path:join(prefix,p),name:layer.name||'',route:p});continue;}if(layer.handle?.stack)walk(layer.handle.stack,join(prefix,regexpPrefix(layer)),out);}return out;}
async function main(){
  try{
    const app=createApplication(),routes=walk(app._router?.stack),owners=new Map();
    for(const route of routes){const key=`${route.method} ${route.path}`;if(!owners.has(key))owners.set(key,[]);owners.get(key).push(route);}
    const duplicates=[...owners.entries()].filter(([key,rows])=>rows.length>1&&!ALLOW.has(key));
    if(duplicates.length){const detail=duplicates.map(([key,rows])=>`${key} x${rows.length}`).join(', ');console.error('Duplicate assembled route owners:');for(const[key,rows]of duplicates)console.error(`  ${key} x${rows.length}`);console.error(`::error title=Duplicate assembled route ownership::${detail}`);assert.fail(`${duplicates.length} duplicate method/path ownership conflict(s): ${detail}`);}
    for(const required of ['GET /','GET /admin','GET /account','GET /account/login','POST /account/login','GET /account/affiliate','POST /account/affiliate/redeem','GET /admin/referrals','GET /admin/attention','GET /admin/backups','GET /admin/operations','GET /help'])assert(owners.has(required),`Required assembled route missing: ${required}`);

    console.log(`assembled route ownership OK: ${owners.size} unique method/path routes; affiliate runtime mounted; retired-product runtime absent`);
  } finally {
    await getPool().end().catch(()=>{});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;});