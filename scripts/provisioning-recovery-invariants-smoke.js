'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const criticalJobs = require('../src/automation/critical-jobs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const compact = value => String(value || '').replace(/\s+/g, '');

const worker = read('scripts/automation-worker.js');
const jobs = read('src/automation/jobs.js');
const entitlementJobs = read('src/jellyfin/jobs.js');
const reconciliationControl = read('src/jellyfin/reconciliation-control.js');
const subscriptionState = read('src/entitlements/subscription-state.js');
const deploymentVerify = read('scripts/verify-deployment.js');
const lifecycle = read('src/payments/lifecycle.js');
const paymentEventRetry = read('src/payments/payment-event-retry.js');
const planChange = read('src/payments/customer-plan-change.js');
const adminAutomation = read('src/platform/admin-automation.js');
const adminManualEntitlement = read('src/platform/admin-manual-entitlement.js');
const entitlementWakeup = read('db/migrations/20260908073500_entitlement_reconciliation_wakeup.sql');
const freeObservationReset = read('db/migrations/20260912090000_free_inactivity_observation_safety_reset.sql');
const serviceRecovery = read('src/automation/customer-service-recovery.js');
const activationCleanup = read('src/automation/activation-cleanup.js');
const freeBackfill = read('src/automation/free-capacity-backfill.js');
const creationIntentRecovery = read('src/automation/jellyfin-creation-intent-recovery.js');
const inactivity = read('src/automation/customer-inactivity.js');
const scopedInactivity = read('src/automation/customer-inactivity-scoped.js');
const accessHolds = read('src/entitlements/access-holds.js');
const revenueIntegrity = read('src/automation/revenue-integrity.js');

for (const jobKey of ['health','entitlements','free_capacity_backfill','customer_inactivity','customer_deletions','creation_intent_recovery','customer_service_recovery','revenue_integrity','billing','provider_operation_recovery','payment_events','plan_changes','activation_cleanup','stremio_managed_accounts','stremio_external_tokens']) {
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
assert(planChange.includes("const provisioning=require('../jellyfin/resilient-provisioning')")
    && planChange.includes('await provisioning.reconcileCustomer(change.customer_id)')
    && planChange.indexOf('await provisioning.reconcileCustomer(change.customer_id)') < planChange.indexOf("SET state='applied',provider_schedule_state='applied'"),
    'scheduled Stripe plan changes must reconcile target access before marking the change applied');

for (const triggerTarget of ['subscriptions','customer_entitlement_overrides','customer_access_holds','customer_service_admin_control']) {
    assert(entitlementWakeup.includes(`ON ${triggerTarget}`),
        `${triggerTarget} entitlement mutations must durably queue customer reconciliation`);
}
assert(entitlementWakeup.includes('reconcile_requested_at')
    && entitlementWakeup.includes("customer_provisioning_state.status='running'"),
    'database wakeups must preserve an in-flight reconciliation while recording a newer entitlement change');
assert(reconciliationControl.includes('reconcile_requested_at=NULL')
    && reconciliationControl.includes('requeueIfRequestedDuringRun(customerId)')
    && (reconciliationControl.match(/await requeueIfRequestedDuringRun\(customerId\)/g) || []).length >= 2,
    'reconciliation completion must requeue an entitlement change that arrived during an in-flight run');

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

// Automatic user-management safety invariants. These deliberately span
// independent modules so a future refactor cannot silently reintroduce the
// failure modes that caused valid customers to be removed or stranded.
const compactRecovery = compact(serviceRecovery);
assert(compactRecovery.includes("statusIN('failed','blocked')")
    && compactRecovery.includes('(next_attempt_atISNULLORnext_attempt_at<=NOW())'),
    'independent service recovery must respect persisted retry/backoff timestamps');

assert(activationCleanup.includes('let warned = 0, removed = 0, protectedCount = 0, failed = 0')
    && activationCleanup.includes('summary.warning')
    && activationCleanup.includes('return summary'),
    'activation cleanup must expose item failures to automation health instead of logging-and-hiding them');
const compactJobs = compact(jobs);
assert(!compactJobs.includes('failed:Number(active.failed||0)+Number(active.blocked||0)'),
    'expected entitlement blockers must not be reported as execution failures');
assert(compactJobs.includes('blocked:blockedCount'),
    'entitlement job health must preserve blocked customers as a separate observable count');

assert(!compact(freeBackfill).includes('c.access_paused_atISNULL'),
    'Free capacity backfill must not trust the denormalized legacy access_paused_at summary');
assert(freeBackfill.includes('liveFreeJellyfinSubscription(row.customer_id, { includeBlocked: true })')
    && freeBackfill.includes('if (!entitlement || entitlement.blocked)'),
    'Free capacity backfill must re-read canonical entitlement/hold authority immediately before provisioning');

const compactIntentRecovery = compact(creationIntentRecovery);
const customerLockAt = compactIntentRecovery.indexOf("SELECTidFROMcustomersWHEREid=$1FORUPDATE");
const intentLockAt = compactIntentRecovery.indexOf("SELECT*FROMjellyfin_account_creation_intentsWHEREid=$1FORUPDATE");
const authorityRecheckAt = compactIntentRecovery.indexOf('constauthoritative=awaitentitlementStillOwnsJellyfin(intent.customer_id,{client})');
const remoteDeleteAt = compactIntentRecovery.indexOf('awaitcompensation.removeCreatedUser({');
assert(customerLockAt >= 0 && intentLockAt > customerLockAt && authorityRecheckAt > intentLockAt && remoteDeleteAt > authorityRecheckAt,
    'stale Jellyfin creation cleanup must lock customer+intent and re-check authority before remote deletion');
assert(creationIntentRecovery.includes("admin?.mode === 'admin_present' || admin?.mode === 'admin_server_pin'"),
    'stale creation cleanup must preserve both admin-present and admin-server-pin authority');

const compactScopedInactivity = compact(scopedInactivity);
assert(compactScopedInactivity.includes('eligibleCount>=CIRCUIT_BREAKER_MAX_ABSOLUTE')
    && compactScopedInactivity.includes('ratio>=CIRCUIT_BREAKER_MAX_RATIO'),
    'mass-removal circuit breaker thresholds must be inclusive');
assert((scopedInactivity.match(/liveFreeJellyfinSubscription\(row\.customer_id, \{ includeBlocked: true \}\)/g) || []).length >= 2,
    'destructive inactivity enforcement must re-check canonical authority before and after telemetry I/O');
assert(scopedInactivity.includes("reason: 'admin_authority_protects_free_access'")
    && scopedInactivity.includes("reason: 'admin_authority_added_during_check'"),
    'inactivity enforcement must fail closed when permanent/admin authority protects Free access');
assert(inactivity.includes('ph.started_at>=ja.access_lane_changed_at'),
    'Free inactivity history must keep the paid-to-Free lane boundary so paid-era playback cannot satisfy a new Free allocation');
assert(freeObservationReset.includes("access_lane='free'")
    && freeObservationReset.includes('disabled=FALSE')
    && freeObservationReset.includes('SET access_lane_changed_at = NOW()'),
    'pre-existing enabled Free accounts must receive one fresh observation window after the ambiguous historical lane-boundary backfill');

assert(accessHolds.includes("error.code = 'ADMIN_ACCESS_HOLD_ACTOR_REQUIRED'")
    && accessHolds.includes("['admin_disabled', 'admin_suspended', 'admin_hold'].includes(requestedType)"),
    'legacy administrative holds must require an authenticated administrator actor');
assert(accessHolds.includes("origin: actorUserId ? 'administrator' : 'automation'"),
    'access-hold audit records must identify whether the mutation came from administrator authority or automation');

for (const invariant of [
    'jellyfin_admin_authority_violation',
    'jellyfin_duplicate_active_lane',
    'actorless_administrative_hold',
    'access_hold_summary_drift'
]) {
    assert(revenueIntegrity.includes(invariant), `revenue-integrity watchdog must detect ${invariant}`);
}
assert(revenueIntegrity.includes("ctl.mode='admin_server_pin'")
    && revenueIntegrity.includes('ja.server_id=ctl.server_id')
    && revenueIntegrity.includes("ctl.mode='admin_removed'"),
    'integrity watchdog must independently verify pinned/present/removed Jellyfin admin desired state');

console.log('provisioning recovery invariants smoke: ok');
