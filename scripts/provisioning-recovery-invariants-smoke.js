'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const worker = read('scripts/automation-worker.js');
const jobs = read('src/automation/jobs.js');
const entitlementJobs = read('src/jellyfin/jobs.js');
const subscriptionState = read('src/entitlements/subscription-state.js');
const deploymentVerify = read('scripts/verify-deployment.js');
const lifecycle = read('src/payments/lifecycle.js');

assert(worker.includes("const buildInfo = require('../src/build-info')") && worker.includes('const COMMIT_SHA = buildInfo.gitSha'),
    'automation worker must report the same CAPTAINFIN_BUILD_SHA identity embedded in the release image');
assert(worker.includes("'free_capacity_backfill'") && worker.includes('assertCriticalJobRegistry()'),
    'automation worker must fail startup if the Free Server recovery job is not registered');
assert(worker.includes('registeredJobs: jobRegistry.names()') && worker.includes('criticalJobs: CRITICAL_JOB_KEYS'),
    'automation heartbeat must expose registered and critical job manifests for deployment diagnostics');
assert(worker.includes('assigned=${assigned} waiting=${waiting} skipped=${skipped}'),
    'Free Server backfill logs must distinguish successful assignment from waiting/skipped applicants');

assert(jobs.includes("freeCapacityBackfill=require('./free-capacity-backfill')")
    && jobs.includes('async free_capacity_backfill(){return freeCapacityBackfill.run({limit:100})}'),
    'Free Server capacity recovery must remain registered as a first-class automation job');

const canonicalAdminPresent = "public.subscription_admin_present(s.customer_id,'jellyfin',s.id)";
assert(subscriptionState.includes(canonicalAdminPresent),
    'canonical Jellyfin entitlement truth must include administrator-present access');
assert(entitlementJobs.includes(canonicalAdminPresent),
    'generic entitlement recovery population must include every administrator-present Jellyfin entitlement');
assert(entitlementJobs.includes("cps.status IN ('pending','running','blocked','failed')"),
    'generic reconciliation must retry persisted provisioning problems independently of acquisition flows');

assert(lifecycle.includes("await primitives.reconcileCommittedCustomer(customerId, automatic ? 'Automatic free plan' : 'Free plan')"),
    'Free plan acquisition must attempt immediate canonical reconciliation');

assert(deploymentVerify.includes("'free_capacity_backfill'")
    && deploymentVerify.includes("'Free Server recovery job'"),
    'deployment verification must fail when the Free Server recovery job is absent, disabled or unhealthy');
assert(deploymentVerify.includes("'automation worker release'")
    && deploymentVerify.includes('automationWorker?.commit_sha'),
    'deployment verification must compare the running automation release to the application release');
assert(deploymentVerify.includes("'automation worker registry'")
    && deploymentVerify.includes("registeredJobs.includes('free_capacity_backfill')"),
    'deployment verification must prove the running worker binary actually registered Free Server recovery');

console.log('provisioning recovery invariants smoke: ok');
