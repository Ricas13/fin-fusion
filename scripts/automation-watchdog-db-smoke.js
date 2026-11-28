'use strict';
require('dotenv').config();
const assert=require('assert');
const {getPool}=require('../src/db');
const {snapshot,evaluate}=require('./automation-watchdog');
const registry=require('../src/automation/jobs');
async function main(){
 const state=await snapshot(getPool());
 assert(Number.isFinite(state.now)&&Math.abs(state.now-Date.now())<60_000,'snapshot uses the actual database clock');
 assert(Array.isArray(state.jobs),'snapshot reads actual migrated job table');
 const defs=registry.names().map(key=>({key,critical:registry.isCritical(key),mayBeDisabled:registry.mayBeDisabled(key)}));
 const result=evaluate({...state,definitions:defs});
 assert.strictEqual(typeof result.ok,'boolean');
 assert(Array.isArray(result.findings));
 assert(result.findings.every(f=>Object.keys(f).every(k=>['severity','code','jobKey'].includes(k))));
 console.log('automation watchdog DB smoke: actual migrated read-only snapshot ok');
}
main().then(()=>getPool().end()).catch(async error=>{console.error(error.stack||error);await getPool().end().catch(()=>{});process.exitCode=1;});
