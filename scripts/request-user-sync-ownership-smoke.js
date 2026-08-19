'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const canonical = read('src/integrations/request-user-sync.js');
const compatibility = read('src/integrations/request-user-sync-v2.js');

assert(canonical.includes('async function syncCandidates()'), 'Historical request-user-sync path must own the implementation');
assert(canonical.includes('async function syncAll()'), 'Canonical request sync module must own reconciliation');
assert(canonical.includes('async function setCustomerPassword('), 'Canonical request sync module must own password synchronization');
assert(!canonical.includes("require('./request-user-sync-v2')"), 'Canonical request sync must not delegate to a versioned implementation');
assert(compatibility.includes("module.exports = require('./request-user-sync')"), 'Versioned request sync path must be compatibility-only');
assert(!compatibility.includes('async function syncCandidates()'), 'Versioned compatibility path must not contain a second implementation');

console.log('request user sync ownership: ok');
