'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const diagnostics = require('../src/platform/system-diagnostics');

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

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const migration = read('db/migrations/029_activity_worker_heartbeat.sql');
const roles = read('scripts/configure-runtime-db-roles.js');
const worker = read('scripts/activity-worker.js');
const system = read('src/platform/system-diagnostics.js');

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

assert(system.includes("runtimeSettings.ensureLoaded()"), 'support diagnostics must load canonical browser-managed runtime settings');
assert(system.includes('runtimeSettings.requireAdminTwoFactor()'), 'admin 2FA posture must come from canonical runtime settings');
assert(system.includes('runtimeSettings.publicRegistrationOpen()'), 'registration posture must come from canonical runtime settings');
assert(system.includes('oldest_queued_age_seconds'), 'notification health must measure queue age');
assert(system.includes("status IN('pending','failed','sending')"), 'notification queue age must include retries and in-flight work');
assert(system.includes('sent_24h') && system.includes('failed_24h'), 'notification diagnostics must expose recent delivery outcomes');
assert(system.includes("queuedAge > 15 * 60"), 'stuck notification detection must use a bounded queue-age threshold');

console.log('worker diagnostics hardening smoke passed');
