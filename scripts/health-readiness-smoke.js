'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const source=fs.readFileSync(path.join(__dirname,'..','src','platform','health.js'),'utf8');

assert(source.includes('const ok=checks.database&&checks.migrations&&checks.runtimeSettings'),'Core readiness must depend on database, migrations and runtime settings');
assert(source.includes('degraded:ok&&!checks.publicOrigin'),'Missing public origin must degrade external-link capability without taking the web process out of service');
assert(!source.includes('Object.values(checks).every(Boolean)'),'A missing public origin must never make the storefront disappear from the reverse proxy');
assert(source.includes('publicOrigin:Boolean(result.checks?.publicOrigin)'),'Readiness must still expose public-origin capability state');
assert(source.includes('READINESS_TIMEOUT_MS=Math.max(1000,Math.min(15000'),'Readiness must have a hard bounded deadline shorter than the Docker probe timeout');
assert(source.includes('Promise.race([')&&source.includes('timeoutResult()'),'Readiness must return a deterministic 503 instead of hanging indefinitely');
assert(source.includes('timedOut:Boolean(result.timedOut)'),'Public health output must make a readiness timeout observable without leaking database errors');
console.log('health readiness smoke: ok');
