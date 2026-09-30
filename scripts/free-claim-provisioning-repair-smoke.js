'use strict';

const assert = require('assert');
const fs = require('fs');
const read = file => fs.readFileSync(file, 'utf8');
const readMaybe = file => fs.existsSync(file) ? read(file) : '';

const readiness = read('src/jellyfin/free-claim-readiness.js');
const bridge = read('src/jellyfin/free-claim-provisioning.js');
const lifecycle = read('src/payments/lifecycle.js');
const reconciliation = read('src/jellyfin/resilient-provisioning.js');
const backfill = read('src/automation/free-capacity-backfill.js');
const jobs = read('src/automation/jobs.js');
const worker = read('scripts/automation-worker.js');
const registration = read('src/platform/customer-public-auth.js');
const router = read('src/platform/router.js');
const accessState = read('src/access/customer-access-state.js');
const accessRepair = readMaybe('src/access/access-repair.js');
const unpaidActivation = readMaybe('src/payments/unpaid-access-activation.js');

assert.match(readiness, /async function hasReadyFreeAccount/, 'Free claims must verify a real Jellyfin account');
assert.match(readiness, /customerAccessState\.freeJellyfin\(customerId/, 'Free readiness must delegate to canonical customer access state');
assert.match(readiness, /ACCESS_STATES\.ACTIVE_READY/, 'Free readiness must only succeed for canonical ACTIVE_READY access');
assert.match(accessState, /laneOf\(account\) !== lane/, 'canonical ready-account matching must enforce the requested access lane');
assert.match(accessState, /account\.disabled \|\| !account\.server_enabled/, 'canonical ready-account matching must require an enabled account on an enabled server');
assert.doesNotMatch(readiness, /forceCustomerDue|reconcileCustomer|retrying automatically|free_capacity_backfill job owns vacancy recovery/, 'Free claim readiness must not create a deployment-pending retry state');
assert.match(bridge, /ensureFreeClaimProvisioned: readiness\.ensureFreeClaimReady/, 'customer routes must use the canonical readiness verifier');

assert.match(lifecycle, /reconcileCommittedCustomerStrict/, 'Free claim activation must retain strict synchronous reconciliation');
assert.match(lifecycle, /readyFreeAccountForSubscription/, 'Free claim success must retain exact-subscription ready-account verification');
assert.match(lifecycle + unpaidActivation, /rollbackUnprovisionedFreeClaim/, 'an unprovisioned Free claim must be rolled back instead of retained');
assert.match(lifecycle, /replacement_reason=CASE WHEN source='free_claim' THEN 'free_claim_activation_failed'/, 'rolled-back Free claims must remain schema-valid while being excluded from one-time historical claim eligibility');
assert.match(reconciliation, /const definitivelyGone = !entitlement \|\| entitlement\.admin_jellyfin_removed === true/, 'no-entitlement Free lanes must delete their Jellyfin account rather than leave a disabled orphan');

assert.match(jobs, /async free_capacity_backfill\(\)\{return freeCapacityBackfill\.run\(\{limit:100\}\)\}/, 'the single Free repair/backfill job must remain registered');
assert.match(worker + jobs, /free_capacity_backfill:30/, 'Free lifecycle repair must remain on the 30-second cadence');
assert.match(backfill + accessRepair, /rollbackUnprovisionedFreeClaim/, 'legacy Free plan-without-server rows must be removed rather than left waiting');
assert.match(backfill, /orphanAccountCandidates/, 'Free server-without-plan rows must be discovered for cleanup');
assert.match(backfill, /waiting: 0/, 'the Free backfill result must not expose a deployment-waiting state');

assert.match(registration, /ensureFreeClaimProvisioned\(created\.customer\.id\)/, 'verified Free registrations must verify actual Jellyfin readiness');
assert.doesNotMatch(registration, /setup is retrying automatically|place is reserved and Jellyfin setup/, 'registration must not advertise deployment pending');
assert.match(router, /ensureFreeClaimProvisioned\(req\.session\.customerId\)/, 'existing customers claiming Free Access must verify actual Jellyfin readiness');
assert.doesNotMatch(router, /place is reserved and Jellyfin setup is retrying automatically/, 'direct Free claims must never advertise deployment pending');
assert.match(router, /Free Access claimed\. Your Jellyfin account is ready\./, 'direct Free claims have one successful end state: plan plus ready account');

console.log('free claim binary provisioning smoke: ok');
