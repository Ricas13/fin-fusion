'use strict';

const assert = require('assert');
const fs = require('fs');
const read = file => fs.readFileSync(file, 'utf8');

const readiness = read('src/jellyfin/free-claim-readiness.js');
const bridge = read('src/jellyfin/free-claim-provisioning.js');
const jobs = read('src/automation/jobs.js');
const worker = read('scripts/automation-worker.js');
const registration = read('src/platform/customer-public-auth.js');
const router = read('src/platform/router.js');

assert.match(readiness, /async function hasReadyFreeAccount/, 'Free claims must verify a real Jellyfin account');
assert.match(readiness, /ja\.access_lane='free'/, 'Free readiness must require the Free lane');
assert.match(readiness, /ja\.disabled=FALSE[\s\S]*js\.enabled=TRUE/, 'Free readiness must require an enabled account on an enabled server');
assert.match(readiness, /await control\.forceCustomerDue\(customerId\)/, 'a committed but unready Free claim must become immediately due');
assert.match(readiness, /Math\.min\(1, Number\(attempts\)/, 'request-path repair must allow at most one extra Jellyfin retry');
assert.match(readiness, /free_capacity_backfill job owns vacancy recovery/, 'capacity failures must be handed to the dedicated Free backfill');
assert.match(bridge, /ensureFreeClaimProvisioned: readiness\.ensureFreeClaimReady/, 'the customer routes must use the canonical readiness helper');

assert.match(jobs, /async free_capacity_backfill\(\)\{return freeCapacityBackfill\.run\(\{limit:100\}\)\}/, 'the single Free vacancy backfill job must remain registered');
assert.doesNotMatch(jobs, /async free_claim_provisioning\(/, 'do not introduce a second competing Free provisioning worker');
assert.match(worker, /free_capacity_backfill:30/, 'Free vacancy recovery must remain on the 30-second cadence');
assert.doesNotMatch(worker, /free_claim_provisioning:30/, 'do not schedule a duplicate Free claim worker');

assert.match(registration, /ensureFreeClaimProvisioned\(created\.customer\.id,\{attempts:2\}\)/, 'verified Free registrations must verify actual Jellyfin readiness');
assert.match(registration, /Your Free Access place is reserved and Jellyfin setup is retrying automatically now/, 'registration must not claim Jellyfin is ready when it is not');
assert.match(router, /ensureFreeClaimProvisioned\(req\.session\.customerId,\{attempts:2\}\)/, 'existing customers claiming Free Access must verify actual Jellyfin readiness');
assert.match(router, /Your Jellyfin account is ready/, 'direct Free claims must distinguish actual Jellyfin readiness');

console.log('free claim provisioning readiness smoke: ok');
