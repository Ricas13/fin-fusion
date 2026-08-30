'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const diagnostics = require('../src/platform/system-diagnostics');
const requestSync = require('../src/integrations/request-user-sync');

const now = Date.now();
const automation = {
  worker_key: 'automation',
  heartbeat_age_seconds: 50,
  draining_at: null,
  metadata: { pollMs: 15000 }
};
const activity = {
  worker_key: 'activity',
  heartbeat_age_seconds: 100,
  draining_at: null,
  metadata: { pollSeconds: 30, lastCycleOutcome: 'healthy' }
};
assert.strictEqual(diagnostics.workerFreshnessSeconds(automation), 90, 'automation freshness must preserve control-plane headroom');
assert.strictEqual(diagnostics.workerFreshnessSeconds(activity), 120, 'activity freshness must derive from its own cadence');
assert.strictEqual(diagnostics.operationalWorkerState(activity), 'healthy');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, heartbeat_age_seconds: 121 }), 'stale');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, metadata: { ...activity.metadata, lastCycleOutcome: 'degraded' } }), 'degraded');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, metadata: { ...activity.metadata, lastCycleOutcome: 'failed' } }), 'failed');
assert.strictEqual(diagnostics.operationalWorkerState({ ...activity, draining_at: new Date(now).toISOString() }), 'draining');

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
const activityTrust = read('src/jellyfin/activity-trust.js');
const jellyfinJobs = read('src/jellyfin/jobs.js');
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
assert(worker.includes('withMaintenanceSharedLock'), 'Activity heartbeat/cycles must remain maintenance-aware');
assert(activityTrust.includes("WHERE worker_key='activity'"), 'Activity trust must read only activity worker instances');
assert(activityTrust.includes('draining_at IS NULL'), 'Activity trust must ignore workers that have begun draining');
assert(activityTrust.includes('ORDER BY last_heartbeat_at DESC'), 'Activity trust must select the freshest live worker instance after multi-instance health migration');
assert(activityTrust.includes('LIMIT 1'), 'Activity trust must collapse multiple live/stale rows to one freshest heartbeat');

assert(jellyfinJobs.includes('summarizeFailureReasons'), 'entitlement reconciliation must aggregate repeated failure causes');
assert(jellyfinJobs.includes('warning = summarizeFailureReasons'), 'entitlement job result must expose a structured warning instead of only a failed count');
assert(jellyfinJobs.includes("replace(/[\\r\\n\\t\\u2028\\u2029]+/g, ' ')"), 'entitlement failure diagnostics must be compact and safe for the automation card');

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
