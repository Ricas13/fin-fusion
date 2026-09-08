'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const criticalJobs = require('../src/automation/critical-jobs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const worker = read('scripts/automation-worker.js');
const jobs = read('src/automation/jobs.js');
const entitlementJobs = read('src/jellyfin/jobs.js');
const subscriptionState = read('src/entitlements/subscription-state.js');
const deploymentVerify = read('scripts/verify-deployment.js');
const lifecycle = read('src/payments/lifecycle.js');
const paymentEventRetry = read('src/payments/payment-event-retry.js');
const adminAutomation = read('src/platform/admin-automation.js');
const adminManualEntitlement = read('src/platform/admin-manual-entitlement.js');

for (const jobKey of ['health','entitlements','free_capacity_backfill','customer_inactivity','billing','provider_operation_recovery','payment_events','plan_changes','stremio_managed_accounts','stremio_external_tokens']) {
    assert(criticalJobs.isCritical(jobKey), `${jobKey} must remain customer-access critical automation`);
}

assert(worker.includes("const buildInfo = require('../src/build-info')") && worker.includes('const COMMIT_SHA = buildInfo.gitSha'),
    'automation worker must report the same CAPTAINFIN_BUILD_SHA identity embedded in the release image');
assert(worker.includes("require('../src/automation/critical-jobs')") && worker.includes('assertCriticalJobRegistry()'),
    'automation worker must use the canonical critical-job registry and fail startup when registration is incomplete');
assert(worker.includes('registeredJobs: jobRegistry.names()') && worker.includes('criticalJobs: CRITICAL_JOB_KEYS'),
    'automation heartbeat must expose registered and critical job manifests for deployment diagnostics');
assert(worker.includes('assigned=${assigned} waiting=${waiting} skipped=${skipped}'),
    'Free Server backfill logs must distinguish successful assignment from waiting/skipped applicants');
assert(worker.includes('warning=${warning}'),
    'degraded automation logs must expose the safe stored failure reason instead of counts alone');
assert(paymentEventRetry.includes('failureWarning(summary, failureReasons)') && paymentEventRetry.includes('warning ? { ...summary, warning } : summary'),
    'payment-event retries must return an aggregated failure reason to automation health');

assert(jobs.includes("freeCapacityBackfill=require('./free-capacity-backfill')")
    && jobs.includes('async free_capacity_backfill(){return freeCapacityBackfill.run({limit:100})}'),
    'Free Server capacity recovery must remain registered as a first-class automation job');

const canonicalAdminPresent = "public.subscription_admin_present(s.customer_id,'jellyfin',s.id)";
assert(subscriptionState.includes(canonicalAdminPresent),
    'canonical Jellyfin entitlement truth must include administrator-present access');
assert(entitlementJobs.includes(canonicalAdminPresent),
    'generic entitlement recovery population must include every administrator-present Jellyfin entitlement');
assert(adminManualEntitlement.includes(canonicalAdminPresent),
    'manual grant conflict detection must not ignore administrator-present Jellyfin access');
assert((lifecycle.match(/public\.subscription_admin_present\(s\.customer_id,'jellyfin',s\.id\)/g)||[]).length >= 2,
    'Free and trial acquisition transaction guards must both honor administrator-present Jellyfin access');
assert(entitlementJobs.includes("cps.status IN ('pending','running','blocked','failed')"),
    'generic reconciliation must retry persisted provisioning problems independently of acquisition flows');

assert(lifecycle.includes("await primitives.reconcileCommittedCustomer(customerId, automatic ? 'Automatic free plan' : 'Free plan')"),
    'Free plan acquisition must attempt immediate canonical reconciliation');

assert(deploymentVerify.includes("require('../src/automation/critical-jobs')")
    && deploymentVerify.includes("'Free Server recovery job'"),
    'deployment verification must consume the canonical critical registry and explicitly verify Free Server recovery');
assert(deploymentVerify.includes("'automation worker release'")
    && deploymentVerify.includes('automationWorker?.commit_sha'),
    'deployment verification must compare the running automation release to the application release');
assert(deploymentVerify.includes('missingRegisteredJobs') && deploymentVerify.includes('requiredJobs = criticalJobs.names()'),
    'deployment verification must prove the running worker registered every access-critical job');

assert(adminAutomation.includes("require('../automation/critical-jobs')")
    && adminAutomation.includes('const CORE_JOBS=new Set(criticalJobs.names())'),
    'operator controls must use the same canonical critical-job list as worker and deployment verification');
assert(adminAutomation.includes("CORE_JOBS.has(req.params.job)") && adminAutomation.includes("Type DISABLE"),
    'core recovery jobs must require explicit confirmation before an operator can disable them');
assert(adminAutomation.includes("ORDER BY last_heartbeat_at DESC LIMIT 1"),
    'automation control room must display the newest worker instance rather than an arbitrary stale heartbeat row');

console.log('provisioning recovery invariants smoke: ok');
