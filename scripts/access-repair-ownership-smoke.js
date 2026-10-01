'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const freeBackfill = read('src/automation/free-capacity-backfill.js');
const jellyfinJobs = read('src/jellyfin/jobs.js');

assert(freeBackfill.includes('accessRepair.repairFreeEntitlement('),
  'Free capacity repair must delegate incomplete Free entitlements to the access repair engine');
assert(freeBackfill.includes('accessRepair.removeOrphanFreeAccount('),
  'Free capacity repair must delegate orphan Free accounts to the access repair engine');
assert(!freeBackfill.includes('rollbackUnprovisionedFreeClaim('),
  'Free capacity worker must not own subscription rollback details');

assert(jellyfinJobs.includes('accessRepair.repairUnpaidTrial('),
  'entitlement reconciliation must delegate stranded unpaid trials to the access repair engine');
assert(!jellyfinJobs.includes('rollbackUnprovisionedJellyfinTrial('),
  'entitlement worker must not own trial rollback details');

console.log('access repair ownership smoke: ok');
