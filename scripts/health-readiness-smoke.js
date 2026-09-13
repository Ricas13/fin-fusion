'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','src','platform','health.js'),'utf8');
const {boundedReadinessTimeout,publicResult}=require('../src/platform/health');

// Keep the pool-overload regression attached to an existing fast-suite root so
// dead-code auditing and CI both prove it on every release.
require('./db-pool-saturation-smoke');

assert(source.includes('const ok=checks.database&&checks.databasePool&&checks.migrations&&checks.runtimeSettings'),'Core readiness must depend on database, bounded web-pool capacity, migrations and runtime settings');
assert(source.includes('checks.databasePool=!pool.overloaded'),'Readiness must fail closed when the configured web DB circuit breaker is overloaded');
assert(source.includes('degraded:ok&&!checks.publicOrigin'),'Missing public origin must degrade external-link capability without taking the web process out of service');
assert(!source.includes('Object.values(checks).every(Boolean)'),'A missing public origin must never make the storefront disappear from the reverse proxy');
assert(source.includes('publicOrigin:Boolean(result.checks?.publicOrigin)'),'Readiness must still expose public-origin capability state');
assert(source.includes('databasePool:Boolean(result.checks?.databasePool)'),'Public readiness must expose web DB pool capability state');
assert(source.includes('const READINESS_TIMEOUT_MS=boundedReadinessTimeout()'),'Readiness must use validated bounded timeout parsing');
assert(source.includes('Promise.race([')&&source.includes('timeoutResult()'),'Readiness must return a deterministic 503 instead of hanging indefinitely');
assert(source.includes('timedOut:Boolean(result.timedOut)'),'Public health output must make a readiness timeout observable without leaking database errors');

const publicHealth=publicResult({
  ok:false,
  degraded:false,
  timedOut:false,
  checks:{database:true,databasePool:false,migrations:true,runtimeSettings:true,publicOrigin:true},
  pool:{max:20,total:20,idle:0,waiting:5,maxWaiting:5,saturated:true,overloaded:true}
});
assert.strictEqual(publicHealth.ok,false,'Pool overload must keep readiness false');
assert.strictEqual(publicHealth.checks.databasePool,false,'Public readiness must preserve the pool-overload signal');
assert.deepStrictEqual(publicHealth.pool,{max:20,total:20,idle:0,waiting:5,maxWaiting:5,saturated:true,overloaded:true},'Public readiness must expose only bounded pool counters and flags');

assert.strictEqual(boundedReadinessTimeout(undefined),6000,'Missing readiness timeout must use the safe default');
assert.strictEqual(boundedReadinessTimeout('not-a-number'),6000,'Invalid readiness timeout must use the safe default instead of becoming an immediate timer');
assert.strictEqual(boundedReadinessTimeout('0'),6000,'Non-positive readiness timeout must use the safe default');
assert.strictEqual(boundedReadinessTimeout('250'),1000,'Readiness timeout must enforce the lower bound');
assert.strictEqual(boundedReadinessTimeout('999999'),15000,'Readiness timeout must enforce the upper bound');
assert.strictEqual(boundedReadinessTimeout('6500.9'),6500,'Readiness timeout must normalize to whole milliseconds');
console.log('health readiness smoke: ok');
