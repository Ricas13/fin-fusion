'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','src','platform','health.js'),'utf8');
const {boundedReadinessTimeout}=require('../src/platform/health');

assert(source.includes('const ok=checks.database&&checks.migrations&&checks.runtimeSettings'),'Core readiness must depend on database, migrations and runtime settings');
assert(source.includes('degraded:ok&&!checks.publicOrigin'),'Missing public origin must degrade external-link capability without taking the web process out of service');
assert(!source.includes('Object.values(checks).every(Boolean)'),'A missing public origin must never make the storefront disappear from the reverse proxy');
assert(source.includes('publicOrigin:Boolean(result.checks?.publicOrigin)'),'Readiness must still expose public-origin capability state');
assert(source.includes('const READINESS_TIMEOUT_MS=boundedReadinessTimeout()'),'Readiness must use validated bounded timeout parsing');
assert(source.includes('Promise.race([')&&source.includes('timeoutResult()'),'Readiness must return a deterministic 503 instead of hanging indefinitely');
assert(source.includes('timedOut:Boolean(result.timedOut)'),'Public health output must make a readiness timeout observable without leaking database errors');
assert.strictEqual(boundedReadinessTimeout(undefined),6000,'Missing readiness timeout must use the safe default');
assert.strictEqual(boundedReadinessTimeout('not-a-number'),6000,'Invalid readiness timeout must use the safe default instead of becoming an immediate timer');
assert.strictEqual(boundedReadinessTimeout('0'),6000,'Non-positive readiness timeout must use the safe default');
assert.strictEqual(boundedReadinessTimeout('250'),1000,'Readiness timeout must enforce the lower bound');
assert.strictEqual(boundedReadinessTimeout('999999'),15000,'Readiness timeout must enforce the upper bound');
assert.strictEqual(boundedReadinessTimeout('6500.9'),6500,'Readiness timeout must normalize to whole milliseconds');
console.log('health readiness smoke: ok');
