'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const diagnostics = require('../src/platform/system-diagnostics');
const workerInstanceHealth = require('../src/platform/worker-instance-health');
const requestSync = require('../src/integrations/request-user-sync');

const now = Date.now();
const automation = {
  worker_key: 'automation',
  heartbeat_age_seconds: 50,
  draining_at: null,
  metadata: {
    pollMs: 15000,
    heartbeatMs: 15000,
    reconciliation: {
      started: 12,
      succeeded: 10,
      failed: 2,
      lockTimeouts: 1,
      cleanupFailures: 0,
      averageDurationMs: 420,
      averageProcessSlotWaitMs: 18,
      averageDatabaseLockWaitMs: 7,
      maxDurationMs: 2100,
      maxProcessSlotWaitMs: 90,
      maxDatabaseLockWaitMs: 42,
      lastErrorCode: 'SHOULD_NOT_LEAK',
      concurrency: { active: 1, queued: 2, limit: 4 }
    }
  }
};
const activity = {
  worker_key: 'activity',
  heartbeat_age_seconds: 100,
  draining_at: null,
  metadata: { pollSeconds: 30, heartbeatMs: 15000, lastCycleOutcome: 'healthy' }
};
assert.strictEqual(diagnostics.workerFreshnessSeconds(automation), 90, 'automation freshness must preserve control-plane headroom');
assert.strictEqual(diagnostics.workerFreshnessSeconds(activity), 120, 'activity freshness must derive from its heartbeat cadence');
assert.strictEqual(workerInstanceHealth.freshnessSeconds({ ...activity, metadata: { ...activity.metadata, heartbeatMs: 60000 } }), 240, 'slow supported heartbeat cadence must expand the activity freshness window');
assert.strictEqual(diagnostics.operationalWorkerState(activity), 'healthy');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, heartbeat_age_seconds: 121 }), 'stale');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, metadata: { ...activity.metadata, lastCycleOutcome: 'degraded' } }), 'degraded');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, metadata: { ...activity.metadata, lastCycleOutcome: 'failed' } }), 'failed');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, draining_at: new Date(now).toISOString() }), 'draining');
const automationView = workerInstanceHealth.instanceView(automation);
assert.deepStrictEqual(automationView.reconciliation, {
  started: 12,
  succeeded: 10,
  failed: 2,
  lockTimeouts: 1,
  cleanupFailures: 0,
  averageDurationMs: 420,
  averageProcessSlotWaitMs: 18,
  averageDatabaseLockWaitMs: 7,
  maxDurationMs: 2100,
  maxProcessSlotWaitMs: 90,
  maxDatabaseLockWaitMs: 42,
  active: 1,
  queued: 2,
  limit: 4
}, 'worker diagnostics must expose only aggregate reconciliation counts/timings and concurrency pressure');
assert.strictEqual(Object.prototype.hasOwnProperty.call(automationView.reconciliation, 'lastErrorCode'), false, 'worker diagnostics must not forward arbitrary reconciliation error strings from heartbeat metadata');

const rolloutSummary = workerInstanceHealth.summarize([
  { worker_key: 'activity', instance_id: 'replacement', heartbeat_age_seconds: 12, draining_at: null, metadata: { heartbeatMs: 15000, lastCycleOutcome: 'healthy' } },
  { worker_key: 'activity', instance_id: 'retiring', heartbeat_age_seconds: 2, draining_at: new Date(now).toISOString(), metadata: { heartbeatMs: 15000, lastCycleOutcome: 'healthy' } }
]);
const rolloutActivity = rolloutSummary.workers.find(worker => worker.key === 'activity');
assert.strictEqual(rolloutActivity.state, 'healthy', 'a fresher draining instance must not override a healthy active replacement');
assert.strictEqual(rolloutActivity.heartbeatAgeSeconds, 12, 'role summary must report the representative active instance, not the draining row');
assert.strictEqual(rolloutActivity.liveInstances, 1, 'draining workers must not count as active instances');
const automationSummary = workerInstanceHealth.summarize([automation]);
assert.strictEqual(automationSummary.workers[0].reconciliation.queued, 2, 'role summary must preserve representative automation reconciliation pressure for System diagnostics/support reports');

const requestSummary = requestSync.emptySummary(5);
requestSync.countResult(requestSummary, { status: 'failed', error: ' Seerr returned HTTP 500\nwhile saving settings ' });
requestSync.countResult(requestSummary, { status: 'failed', error: 'Seerr returned HTTP 500 while saving settings' });
requestSync.countResult(requestSummary, { status: 'failed', error: 'Permission endpoint rejected payload' });
requestSync.countResult(requestSummary, { status: 'synced' });
requestSync.countResult(requestSummary, { status: 'suspended' });
const finalizedRequestSummary = requestSync.finalizeSummary(requestSummary);
assert.strictEqual(finalizedRequestSummary.failed, 3, 'request-user summary must preserve the failed count used by automation health');
assert.match(finalizedRequestSummary.warning, /3 request-user syncs failed/, 'request-user job must expose a useful degraded warning');
assert.match(finalizedRequestSummary.warning, /2× Seerr returned HTTP 500 while saving settings/, 'request-user warning must surface the dominant real failure cause and count');
assert.match(finalizedRequestSummary.warning, /1 other failure/, 'request-user warning should acknowledge additional distinct causes without flooding the card');
assert.strictEqual(Object.prototype.hasOwnProperty.call(finalizedRequestSummary, '_failureReasons'), false, 'temporary diagnostic aggregation must not leak into the persisted automation result');
assert.strictEqual(requestSync.cleanFailureMessage('  spaced\n\nmessage  '), 'spaced message', 'failure messages must be compacted before display');
assert(requestSync.cleanFailureMessage('x'.repeat(600)).length <= 300, 'individual failure diagnostics must be bounded');
const cleanSummary = requestSync.finalizeSummary(requestSync.emptySummary(0));
assert.deepStrictEqual(cleanSummary, { total: 0, created: 0, linked: 0, suspended: 0, failed: 0 }, 'successful request-user summaries must keep their existing public shape');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('db/migrations/029_activity_worker_heartbeat.sql');
const roles = read('scripts/configure-runtime-db-roles.js');
const worker = read('scripts/activity-worker.js');
const automationWorker = read('scripts/automation-worker.js');
const activityTrust = read('src/jellyfin/activity-trust.js');
const jellyfinJobs = read('src/jellyfin/jobs.js');
const automationJobs = read('src/automation/jobs.js');
const compose = read('docker-compose.yml');
const envExample = read('.env.example');
const system = read('src/platform/system-diagnostics.js');
const requestUserSync = read('src/integrations/request-user-sync.js');
const jobHealth = read('src/automation/job-health.js');

assert(migration.includes('SECURITY DEFINER'), 'Activity heartbeat should use a narrow definer function instead of table write grants');
assert(migration.includes('SET search_path = pg_catalog, public'), 'security definer must pin a safe search path');
assert(migration.includes('REVOKE ALL ON FUNCTION public.record_activity_worker_heartbeat'), 'heartbeat definer must not be executable by PUBLIC');
assert(roles.includes('GRANT EXECUTE ON FUNCTION public.record_activity_worker_heartbeat'), 'Activity role must receive only heartbeat function execution');
const grantActivity = roles.slice(roles.indexOf('async function grantActivity'), roles.indexOf('async function grantBackup'));
assert(!/GRANT\s+(?:SELECT,)?INSERT,UPDATE[^\n]*operational_worker_state/.test(grantActivity), 'Activity role must not receive direct operational-worker table writes');

assert(worker.includes("worker_key='activity'") === false, 'Activity worker should not be able to choose an arbitrary worker row');
assert(worker.includes('record_activity_worker_heartbeat'), 'Activity worker must publish through the fixed-key heartbeat function');
assert(worker.includes("lastCycleOutcome"), 'Activity heartbeat metadata must include cycle outcome');
assert(worker.includes('serverFailures'), 'Activity heartbeat metadata must include downstream server-failure count');
assert(worker.includes('heartbeatMs: HEARTBEAT_MS'), 'Activity heartbeat metadata must publish its independent liveness cadence');
assert(worker.includes('heartbeatTimer = setInterval'), 'Activity worker must heartbeat independently of the playback poll loop');
assert(worker.includes("if (result?.recorded || result?.reason === 'database_maintenance') heartbeat();"), 'Local activity health must advance only when the database heartbeat path is proven reachable');
assert(worker.includes('withMaintenanceSharedLock'), 'Activity heartbeat/cycles must remain maintenance-aware');
assert(automationWorker.includes('heartbeatMs: HEARTBEAT_MS'), 'Automation heartbeat metadata must publish its liveness cadence');
assert(automationWorker.includes("require('../src/jellyfin/reconciliation-lock')")&&automationWorker.includes('reconciliation: reconciliationLock.metricsSnapshot()'), 'Automation heartbeat must publish process-local reconciliation pressure for cross-process diagnostics');
assert(activityTrust.includes("WHERE worker_key='activity'"), 'Activity trust must read only activity worker instances');
assert(activityTrust.includes('draining_at IS NULL'), 'Activity trust must ignore workers that have begun draining');
assert(activityTrust.includes('ORDER BY last_heartbeat_at DESC'), 'Activity trust must select the freshest live worker instance after multi-instance health migration');
assert(activityTrust.includes('LIMIT 1'), 'Activity trust must collapse multiple live/stale rows to one freshest heartbeat');
assert(activityTrust.includes("intEnv('ACTIVITY_WORKER_HEARTBEAT_MS'"), 'Activity trust freshness must follow the independent worker heartbeat cadence');

assert(jellyfinJobs.includes('summarizeFailureReasons'), 'entitlement reconciliation must aggregate repeated failure causes');
assert(jellyfinJobs.includes('warning = summarizeFailureReasons'), 'entitlement job result must expose a structured warning instead of only a failed count');
assert(jellyfinJobs.includes('blocked pending recovery'), 'blocked reconciliation must surface an operator-visible degraded warning');
assert(jellyfinJobs.includes("replace(/[\\r\\n\\t\\u2028\\u2029]+/g, ' ')"), 'entitlement failure diagnostics must be compact and safe for the automation card');
assert(automationJobs.includes('Number(active.blocked||0)'), 'blocked entitlement reconciliation must contribute to the automation failed count and degraded outcome');

assert(compose.includes("instance_id=$1 AND draining_at IS NULL"), 'Automation container health must check its own non-draining worker instance');
assert(compose.includes('[process.env.HOSTNAME]'), 'Automation container health must bind the current container instance id instead of reading an arbitrary row');
assert(compose.includes('ACTIVITY_WORKER_HEARTBEAT_MS: ${ACTIVITY_WORKER_HEARTBEAT_MS:-15000}'), 'Compose must pass the independent activity heartbeat cadence');
assert(envExample.includes('ACTIVITY_WORKER_HEARTBEAT_MS=15000'), 'Example configuration must document the activity heartbeat cadence');

assert(system.includes("runtimeSettings.ensureLoaded()"), 'support diagnostics must load canonical browser-managed runtime settings');
assert(system.includes('runtimeSettings.requireAdminTwoFactor()'), 'admin 2FA posture must come from canonical runtime settings');
assert(system.includes('runtimeSettings.publicRegistrationOpen()'), 'registration posture must come from canonical runtime settings');
assert(system.includes('oldest_queued_age_seconds'), 'notification health must measure queue age');
assert(system.includes("status IN('pending','failed','sending')"), 'notification queue age must include retries and in-flight work');
assert(system.includes('sent_24h') && system.includes('failed_24h'), 'notification diagnostics must expose recent delivery outcomes');
assert(system.includes("queuedAge > 15 * 60"), 'stuck notification detection must use a bounded queue-age threshold');
assert(requestUserSync.includes('summary.warning'), 'request-user sync must return a diagnostic warning when sub-operations fail');
assert(jobHealth.includes('result.warning || result.message || result.error || result.lastError'), 'automation health must continue preferring structured job warnings over a generic failed-count fallback');

console.log('worker diagnostics hardening smoke passed');
