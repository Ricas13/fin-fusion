'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const criticalJobs = require('../src/automation/jobs');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const readMaybe = file => fs.existsSync(path.join(root, file)) ? read(file) : '';
const compact = value => String(value || '').replace(/\s+/g, '');

const worker = read('scripts/automation-worker.js');
const jobs = read('src/automation/jobs.js');
const entitlementJobs = read('src/jellyfin/jobs.js');
const reconciliationControl = read('src/jellyfin/reconciliation-control.js');
const subscriptionState = read('src/entitlements/subscription-state.js');
const deploymentVerify = read('scripts/verify-deployment.js');
const lifecycle = read('src/payments/lifecycle.js');
const lifecyclePrimitives = read('src/payments/lifecycle-primitives.js');
const unpaidActivation = readMaybe('src/payments/unpaid-access-activation.js');
const paymentEventRetry = read('src/payments/payment-event-retry.js');
const planChange = read('src/payments/customer-plan-change.js');
const adminAutomation = read('src/platform/admin-automation.js');
const adminManualEntitlement = read('src/platform/admin-manual-entitlement.js');
const adminManualEntitlementService = read('src/entitlements/admin-manual-entitlement-service.js');
const entitlementWakeup = read('db/migrations/20260908073500_entitlement_reconciliation_wakeup.sql');
const freeObservationReset = read('db/migrations/20260912090000_free_inactivity_observation_safety_reset.sql');
const serviceRecovery = read('src/automation/customer-service-recovery.js');
const activationCleanup = read('src/automation/activation-cleanup.js');
const freeBackfill = read('src/automation/free-capacity-backfill.js');
const customerAccessState = read('src/access/customer-access-state.js');
const accessRepair = readMaybe('src/access/access-repair.js');
const creationIntentRecovery = read('src/automation/jellyfin-creation-intent-recovery.js');
const creationIntentRecoveryApi = require('../src/automation/jellyfin-creation-intent-recovery');
const inactivity = read('src/automation/customer-inactivity.js');
const scopedInactivity = read('src/automation/customer-inactivity-scoped.js');
const inactivityGrace = read('src/entitlements/jellyfin-inactivity-grace.js');
const accessHolds = read('src/entitlements/access-holds.js');
const revenueIntegrity = read('src/automation/revenue-integrity.js');

for (const jobKey of ['health','entitlements','free_capacity_backfill','customer_inactivity','customer_deletions','creation_intent_recovery','customer_service_recovery','revenue_integrity','billing','provider_operation_recovery','payment_events','plan_changes','activation_cleanup','stremio_managed_accounts','stremio_external_tokens']) {
    assert(criticalJobs.isCritical(jobKey), `${jobKey} must remain customer-access critical automation`);
}

assert(worker.includes("const buildInfo = require('../src/build-info')") && worker.includes('const COMMIT_SHA = buildInfo.gitSha'),
    'automation worker must report the same CAPTAINFIN_BUILD_SHA identity embedded in the release image');
assert(worker.includes('jobRegistry.criticalNames()')
    && worker.includes('assertCriticalJobRegistry()')
    && worker.includes('jobRegistry.definition(jobKey)?.run'),
    'automation worker must use canonical job definitions for critical classification and fail startup when registration is incomplete');
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
assert(subscriptionState.includes('async function livePrimarySubscription') && subscriptionState.includes(canonicalAdminPresent)
    && adminManualEntitlementService.includes('subscriptionState.livePrimarySubscription'),
    'manual grant conflict detection must consume canonical primary subscription truth including administrator-present Jellyfin access');
assert(adminManualEntitlement.includes("require('../entitlements/admin-manual-entitlement-service')"),
    'manual entitlement platform route must delegate conflict detection to the entitlement domain');
assert(subscriptionState.includes('lockLiveFreeClaimSubscriptions')
    && subscriptionState.includes(canonicalAdminPresent)
    && (lifecycle.match(/public\.subscription_admin_present\(s\.customer_id,'jellyfin',s\.id\)/g)||[]).length >= 1,
    'Free and trial acquisition transaction guards must both honor administrator-present Jellyfin access through their canonical owners');
assert(entitlementJobs.includes("cps.status IN ('pending','running','blocked','failed')"),
    'generic entitlement recovery population must include every administrator-present Jellyfin entitlement');

assert(lifecycle.includes('reconcileCommittedCustomerStrict')
    && (
        lifecycle.includes('rollbackUnprovisionedFreeClaim(customerId,created.id')
        || (
            lifecycle.includes('rollback:rollbackUnprovisionedFreeClaim')
            && unpaidActivation.includes('await rollback(customerId, subscriptionId')
        )
    ),
    'Free plan acquisition must synchronously reconcile and roll back if no enabled Free Server account is created');
assert((
        lifecycle.includes('rollbackUnprovisionedJellyfinTrial(customerId,created.id')
        || (
            lifecycle.includes('rollback:rollbackUnprovisionedJellyfinTrial')
            && unpaidActivation.includes('await rollback(customerId, subscriptionId')
        )
    )
    && lifecycle.includes("replacement_reason='trial_activation_failed'"),
    'unpaid Jellyfin trials must roll back when no enabled primary server account can be created');
assert(lifecyclePrimitives.includes("await reconcileCustomer(customerId)")
    && lifecyclePrimitives.includes("return null;"),
    'the retryable non-strict reconciliation helper must remain available for paid entitlements');
assert(lifecyclePrimitives.includes("await reconcileCommittedCustomer(customerId, activationSuppressedByMoneyLoss ? 'Money-loss checkout replay' : historicalCheckoutReplay ? 'Historical checkout replay' : 'Paid subscription')"),
    'paid subscription activation is the deliberate plan-without-server exception and must retain the committed plan while reconciliation retries');
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

assert(deploymentVerify.includes("require('../src/automation/jobs')")
    && deploymentVerify.includes("'Free Server recovery job'"),
    'deployment verification must consume the canonical automation registry and explicitly verify Free Server recovery');
assert(deploymentVerify.includes("'automation worker release'")
    && deploymentVerify.includes('automationWorker?.commit_sha'),
    'deployment verification must compare the running automation release to the application release');
assert(deploymentVerify.includes('missingRegisteredJobs') && deploymentVerify.includes('requiredJobs = jobRegistry.criticalNames()'),
    'deployment verification must prove the running worker registered every access-critical job');

assert(adminAutomation.includes("require('../automation/jobs')")
    && adminAutomation.includes('const CORE_JOBS=new Set(jobRegistry.criticalNames())'),
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
assert(customerAccessState.includes('subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked })'),
    'canonical Free access state must re-read entitlement and hold authority before repair decisions');
assert(freeBackfill.includes('accessRepair.repairFreeEntitlement('),
    'Free lifecycle repair must delegate exact-subscription repair to the canonical access repair layer');
execFileSync(process.execPath, [path.join(root, 'scripts/access-repair-behavior-smoke.js')], { stdio: 'inherit' });

const compactIntentRecovery = compact(creationIntentRecovery);
const customerLockAt = compactIntentRecovery.indexOf("SELECTidFROMcustomersWHEREid=$1FORUPDATE");
const intentLockAt = compactIntentRecovery.indexOf("SELECTi.*,COALESCE(s.media_server_type,'jellyfin')ASmedia_server_typeFROMjellyfin_account_creation_intentsiJOINjellyfin_serverssONs.id=i.server_idWHEREi.id=$1FORUPDATEOFi");
const authorityRecheckAt = compactIntentRecovery.indexOf('constauthoritative=awaitentitlementStillOwnsJellyfin(intent.customer_id,{client})');
const remoteDeleteAt = compactIntentRecovery.indexOf('awaitcompensation.removeCreatedUser({');
assert(customerLockAt >= 0 && intentLockAt > customerLockAt && authorityRecheckAt > intentLockAt && remoteDeleteAt > authorityRecheckAt,
    'stale Jellyfin creation cleanup must lock customer+intent and re-check authority before remote deletion');
assert(creationIntentRecovery.includes("const adminOwns = admin?.mode === 'admin_present'"),
    'stale creation cleanup must treat admin-present as access authority while keeping server pins placement-only');
assert(creationIntentRecovery.includes('intentServerStillOwned')
    && creationIntentRecovery.includes('intent?.access_lane')
    && creationIntentRecovery.includes('String(row.media_server_id) === serverId'),
    'stale creation recovery must scope persisted entitlements to the exact access lane and assigned server');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'server-old', access_lane:'primary' },
    { owns:true, primary:{ media_server_id:'server-new' }, free:null, admin:null }
), false, 'an intent on a superseded server must no longer be preserved by a different persisted assignment');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'server-old', access_lane:'primary' },
    { owns:true, primary:{ media_server_id:null }, free:null, admin:null }
), true, 'legacy entitlements without a persisted assignment must remain fail-closed and preserve the matching lane intent');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'server-pin', access_lane:'primary' },
    { owns:false, primary:null, free:null, admin:{ mode:'admin_server_pin', server_id:'server-pin' } }
), false, 'a placement-only admin pin must never preserve a creation intent after entitlement authority ends');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'server-pin', access_lane:'free' },
    { owns:true, primary:{ media_server_id:'server-pin' }, free:null, admin:{ mode:'admin_server_pin', server_id:'server-pin' } }
), false, 'a paid primary entitlement must not preserve a stale Free-lane creation intent on the same pinned server');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'server-pin', access_lane:'primary' },
    { owns:true, primary:{ media_server_id:'server-old' }, free:null, admin:{ mode:'admin_server_pin', server_id:'server-pin' } }
), true, 'a server pin may redirect the still-entitled matching lane to the pinned server');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'emby-a', access_lane:'primary', media_server_type:'emby' },
    { owns:true, jellyfinOwns:false, embyOwns:true, primary:null, free:null, emby:{ media_server_id:'emby-a' }, admin:null }
), true, 'an active Emby entitlement must preserve its durable creation intent on the assigned Emby server');
assert.strictEqual(
    creationIntentRecoveryApi.entitlementOwnsLane({ media_server_id:'server-a', blocked:true }),
    false,
    'blocked media entitlements must never retain creation-intent ownership'
);
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'emby-a', access_lane:'primary', media_server_type:'emby' },
    { owns:true, jellyfinOwns:false, embyOwns:true, primary:null, free:null, emby:{ media_server_id:'emby-a', blocked:true }, admin:null }
), false, 'a blocked/refunded Emby entitlement must not preserve an unmanaged remote creation intent');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'server-a', access_lane:'primary', media_server_type:'jellyfin' },
    { owns:true, jellyfinOwns:true, primary:{ media_server_id:'server-a', blocked:true }, free:null, admin:null }
), false, 'a blocked paid Jellyfin entitlement must not preserve an unmanaged remote creation intent');
assert.strictEqual(creationIntentRecoveryApi.intentServerStillOwned(
    { server_id:'emby-old', access_lane:'primary', media_server_type:'emby' },
    { owns:true, jellyfinOwns:true, embyOwns:true, primary:{ media_server_id:'jellyfin-a' }, free:null, emby:{ media_server_id:'emby-new' }, admin:{ mode:'admin_present' } }
), false, 'Jellyfin admin authority must never preserve an Emby creation intent on a superseded Emby server');

const compactScopedInactivity = compact(scopedInactivity);
assert(compactScopedInactivity.includes("INACTIVITY_MAX_ENFORCEMENTS_PER_RUN',100")
    && compactScopedInactivity.includes('eligible.slice(0,MAX_ENFORCEMENTS_PER_RUN)'),
    'large inactivity cleanups may be throughput-capped without changing eligibility');
const inactivityRemovalStart=scopedInactivity.indexOf('async function removeEligibleAccount');
const inactivityRemovalEnd=scopedInactivity.indexOf('async function runPlanRules',inactivityRemovalStart);
const inactivityRemovalBlock=scopedInactivity.slice(inactivityRemovalStart,inactivityRemovalEnd);
assert(inactivityRemovalStart>=0
    && inactivityRemovalBlock.includes('await provisioning.deleteJellyfinAccount(')
    && !inactivityRemovalBlock.includes('await provisioning.reconcileCustomer('),
    'inactivity removal itself must delete the exact Free account directly; protected partial-recovery finalization may reconcile separately');
assert(scopedInactivity.includes("reason: 'admin_authority_protects_free_access'"),
    'inactivity enforcement must fail closed when permanent/admin-present authority protects Free access');
assert(scopedInactivity.includes('withCustomerReconciliationLock'),
    'the final Free-account decision and delete must stay serialized per customer');
assert(inactivity.includes('GREATEST(')
    && inactivity.includes('fa.starts_at')
    && inactivity.includes('ja.created_at')
    && inactivity.includes('ja.access_lane_changed_at')
    && inactivity.includes('automation_resume.resumed_at'),
    'Free allocation must start at the newest real allocation/re-add boundary so older playback cannot satisfy it');
assert(!inactivity.includes('historical_first_playback_at')
    && !inactivity.includes('any_playback_history'),
    'historical playback heuristics must not move a current allocation boundary backwards');
assert(freeObservationReset.includes('ADD COLUMN IF NOT EXISTS inactivity_observation_reset_at')
    && freeObservationReset.includes("access_lane_changed_at<=lt.applied_at")
    && !freeObservationReset.includes('SET access_lane_changed_at = NOW()'),
    'legacy inactivity safety must mark ambiguous pre-column Free rows without rewriting their real lane boundary');
assert(inactivityGrace.includes("source: 'legacy_lane_backfill'")
    && inactivityGrace.includes('legacySafetyHours(row)')
    && inactivityGrace.includes('row?.inactivity_observation_reset_at'),
    'the one-time ambiguous legacy lane marker must remain the only compatibility grace before destructive inactivity enforcement');

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
