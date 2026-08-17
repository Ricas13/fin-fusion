'use strict';

const assert=require('assert');
const fs=require('fs');

const source=fs.readFileSync('src/platform/customer-communications.js','utf8');

assert.match(source,/async function safeOptional\(/,'communications page must isolate optional subsystem failures');
assert.match(source,/safeOptional\('delivery status'/,'delivery status must degrade independently');
assert.match(source,/safeOptional\('notification event catalogue'/,'event catalogue must degrade independently');
assert.match(source,/safeOptional\('customer event preferences'/,'customer event preferences must degrade independently');
assert.match(source,/safeOptional\('preferred currency'/,'preferred currency must degrade independently');
assert.match(source,/safeOptional\('enabled currencies'/,'enabled currencies must degrade independently');
assert.doesNotMatch(source,/Promise\.all\(\[prefs\(req\.session\.customerId\).*allowedEvents/s,'optional communications lookups must not share one fail-all Promise.all');
assert.match(source,/const row=await prefs\(req\.session\.customerId\)/,'core communications preference lookup must remain required');
assert.match(source,/Customer communications \$\{label\} unavailable:/,'degraded optional lookups must identify themselves in server logs');

console.log('customer communications page resilience smoke passed');
