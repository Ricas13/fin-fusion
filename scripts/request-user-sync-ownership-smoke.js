'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root=path.join(__dirname,'..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const canonical = read('src/integrations/request-user-sync.js');

assert(canonical.includes('async function syncCandidates(options = {})'), 'Historical request-user-sync path must own the implementation');
assert(canonical.includes('async function syncAll()'), 'Canonical request sync module must own reconciliation');
assert(canonical.includes('async function setCustomerPassword('), 'Canonical request sync module must own password synchronization');
assert(canonical.includes('REQUEST_SCAN_KEY')&&canonical.includes('scanCursor.load(REQUEST_SCAN_KEY)')&&canonical.includes('scanCursor.save(REQUEST_SCAN_KEY, cursor)'), 'Canonical recurring request sync must keep durable bounded progress');
assert(!canonical.includes("require('./request-user-sync-v2')"), 'Canonical request sync must not delegate to a versioned implementation');
assert(!fs.existsSync(path.join(root,'src/integrations/request-user-sync-v2.js')), 'retired versioned request sync compatibility path must stay removed');

console.log('request user sync ownership: ok');
