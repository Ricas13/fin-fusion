'use strict';

const assert=require('assert');
const fs=require('fs');
const read=file=>fs.readFileSync(file,'utf8');

const repair=read('src/jellyfin/free-claim-provisioning.js');
const jobs=read('src/automation/jobs.js');
const worker=read('scripts/automation-worker.js');
const registration=read('src/platform/customer-public-auth.js');
const router=read('src/platform/router.js');

assert.match(repair,/async function ensureFreeClaimProvisioned/,'Free claims need an explicit immediate provisioning helper');
assert.match(repair,/await control\.forceCustomerDue\(customerId\)/,'a committed Free claim must be durably due before/after immediate reconciliation');
assert.match(repair,/for\(let attempt=1;attempt<=maxAttempts;attempt\+=1\)/,'Free claims must receive bounded immediate retries');
assert.match(repair,/ja\.access_lane='free'/,'repair must verify an actual Free-lane Jellyfin account, not merely a subscription');
assert.match(repair,/NOT EXISTS\([\s\S]*h\.hold_type IN\('inactivity_policy','jellyfin_cleanup'\)/,'repair must not resurrect inactivity-removed Free users');
assert.match(repair,/b\.blocks_service_access=TRUE/,'repair must respect customer service bans');
assert.match(repair,/c\.access_paused_at IS NULL/,'repair must respect paused customer access');
assert.match(repair,/s\.status IN\('active','trialing','past_due','paused'\)/,'repair must only consider live subscriptions');
assert.match(repair,/repairPendingFreeClaims/,'repair scanner must expose a worker entry point');

assert.match(jobs,/async free_claim_provisioning\(\)\{return freeClaimProvisioning\.repairPendingFreeClaims\(\{limit:100\}\)\}/,'automation registry must run the Free claim repair');
assert.match(worker,/free_claim_provisioning:30/,'Free claim repair must default to a 30-second interval');

assert.match(registration,/ensureFreeClaimProvisioned\(created\.customer\.id,\{attempts:2\}\)/,'verified Free registrations must immediately retry provisioning');
assert.match(registration,/Your Free Access place is reserved and Jellyfin setup is retrying automatically now/,'registration must not falsely claim Jellyfin is ready when provisioning failed');
assert.match(router,/ensureFreeClaimProvisioned\(req\.session\.customerId,\{attempts:2\}\)/,'existing customers claiming Free Access must immediately retry provisioning');
assert.match(router,/Your Jellyfin account is ready/,'direct claim flow must distinguish actual Jellyfin readiness');

console.log('free claim provisioning repair smoke: ok');
