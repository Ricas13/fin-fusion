'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const policy = require('../src/jellyfin/policy');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

// Pure policy proof: the same customer can have an independent Free=1 and
// Primary=3 effective limit without either override bleeding into the other.
const free = policy.effectiveTechnicalPolicy({ streams: 1, allow_downloads: false }, { allow_downloads: true });
const primary = policy.effectiveTechnicalPolicy({ streams: 3, allow_downloads: true }, { streams: 3 });
assert.strictEqual(free.streams.effective, 1);
assert.strictEqual(primary.streams.effective, 3);
assert.strictEqual(free.allow_downloads.effective, true);
assert.strictEqual(primary.allow_downloads.effective, true);

const laneWorker = read('src/jellyfin/lane-stream-policy.js');
assert.match(laneWorker, /jellyfin_account_id/);
assert.match(laneWorker, /liveFreeJellyfinSubscription/);
assert.match(laneWorker, /effectiveSubscription/);
assert.match(laneWorker, /confirmed_lane_concurrent_stream_limit/);
assert.doesNotMatch(laneWorker, /groups\.set\(row\.customer_id/);

const worker = read('scripts/activity-worker.js');
assert.match(worker, /jellyfin\/lane-stream-policy/);

const impersonation = read('src/platform/admin-impersonation.js');
assert.match(impersonation, /Nested impersonation is not allowed/);
assert.match(impersonation, /row\?\.role === 'customer'/);
assert.match(impersonation, /admin\.impersonation\.customer_action/);
assert.match(impersonation, /Exit impersonation/);
assert.match(impersonation, /View portal as customer/);

const migration = read('db/migrations/099_lane_scoped_customer_policy.sql');
assert.match(migration, /access_lane IN \('primary','free'\)/);
assert.match(migration, /SELECT customer_id,'primary'/);
assert.doesNotMatch(migration, /SELECT customer_id,'free'.*customer_policy_overrides/s);
assert.match(migration, /email IS NULL/);

const claim = read('src/platform/customer-claim.js');
assert.match(claim, /Email <span class="help">\(optional\)<\/span>/);
assert.match(claim, /req\.body\.email \|\| null/);
const customers = read('src/customers.js');
assert.match(customers, /lower\(u\.email\)=lower\(\$1\) OR lower\(u\.username\)=lower\(\$1\)/);
assert.match(customers, /changePortalPassword\(userId,currentPassword,newPassword,currentSessionId\)/);

console.log('lane policy / imported-user / impersonation smoke: ok');
