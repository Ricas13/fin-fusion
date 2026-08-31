'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jobHealth = require('../src/automation/job-health');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

assert.strictEqual(jobHealth.failedCountFromResult({ failed: 4 }), 4, 'failed result count should be detected');
assert.strictEqual(jobHealth.failedCountFromResult({ errors: 2 }), 2, 'errors result count should be detected');
assert.strictEqual(jobHealth.failedCountFromResult({ processed: 8 }), 0, 'clean result should not be degraded');

assert.strictEqual(jobHealth.retryDelaySeconds(300, 1), 60, 'first retry should happen after one minute');
assert.strictEqual(jobHealth.retryDelaySeconds(300, 2), 180, 'second retry should back off');
assert.strictEqual(jobHealth.retryDelaySeconds(300, 3), 300, 'retry must not exceed the normal five-minute schedule');
assert.strictEqual(jobHealth.retryDelaySeconds(10800, 4), 900, 'long-interval jobs should cap retry delay at fifteen minutes');

const now = Date.now();
const base = {
    enabled: true,
    interval_seconds: 300,
    last_started_at: new Date(now - 5000).toISOString(),
    last_completed_at: new Date(now - 1000).toISOString(),
    last_success_at: new Date(now - 600000).toISOString(),
    last_error: null
};
assert.strictEqual(jobHealth.healthState({ ...base, last_outcome: 'success' }, now), 'healthy');
assert.strictEqual(jobHealth.healthState({ ...base, last_outcome: 'degraded', last_failed_count: 2 }, now), 'degraded');
assert.strictEqual(jobHealth.healthState({ ...base, last_outcome: 'failed', last_error: 'boom' }, now), 'failed');
assert.strictEqual(jobHealth.healthState({ ...base, last_started_at: new Date(now).toISOString(), last_completed_at: new Date(now - 10000).toISOString() }, now), 'running');

const releaseWorkflow = read('.github/workflows/release-integrity.yml');
assert(releaseWorkflow.includes('production-readiness.js --json --ci-schema'), 'Release Integrity must execute the CI schema readiness contract');
assert(!/production-readiness\.js[^\n]*\|\|\s*true/.test(releaseWorkflow), 'Production readiness must not be suppressed with || true');

const readiness = read('scripts/production-readiness.js');
assert(readiness.includes("process.argv.includes('--ci-schema')"), 'Production readiness should expose an explicit CI schema mode');
assert(readiness.includes("'database.audit_failed'"), 'Database audit failures must remain critical');

const migration = read('db/migrations/028_automation_job_outcomes.sql');
for (const field of ['last_completed_at', 'last_outcome', 'last_failed_count', 'last_warning']) {
    assert(migration.includes(field), `Automation outcome migration must add ${field}`);
}

const worker = read('scripts/automation-worker.js');
assert(worker.includes('DB_CONTROL_HEADROOM'), 'Automation worker must reserve database control headroom');
assert(worker.includes('Math.min(REQUESTED_CONCURRENCY, DB_POOL_SIZE - DB_CONTROL_HEADROOM)'), 'Worker concurrency must be bounded by its DB pool');

const compose = read('docker-compose.yml');
const roleScript = read('scripts/configure-runtime-db-roles.js');
const maintenanceLock = read('src/security/maintenance-lock.js');
const automationRoleLimit = Number(/automation:\s*\{[^}]*connectionLimit:\s*(\d+)/s.exec(roleScript)?.[1]);
const automationPoolDefault = Number(/AUTOMATION_DB_POOL_SIZE:-([0-9]+)/.exec(compose)?.[1]);
const automationLockDefault = Number(/AUTOMATION_DEFAULT_LOCK_POOL_MAX\s*=\s*(\d+)/.exec(maintenanceLock)?.[1]);
const automationNonPoolReserve = Number(/AUTOMATION_NON_POOL_RESERVE\s*=\s*(\d+)/.exec(maintenanceLock)?.[1]);
assert(Number.isFinite(automationRoleLimit), 'Automation database role must have an explicit connection limit');
assert(Number.isFinite(automationPoolDefault), 'Compose must expose the automation primary pool default');
assert(Number.isFinite(automationLockDefault), 'Maintenance lock owner must expose the automation lock-pool default');
assert(Number.isFinite(automationNonPoolReserve), 'Maintenance lock owner must reserve direct/control automation connections');
assert.strictEqual(Number(/AUTOMATION_ROLE_CONNECTION_LIMIT\s*=\s*(\d+)/.exec(maintenanceLock)?.[1]), automationRoleLimit,
    'Maintenance-lock safety budget must track the PostgreSQL automation role connection limit');
assert(automationPoolDefault + automationLockDefault + automationNonPoolReserve <= automationRoleLimit,
    'Default automation primary + maintenance-lock + direct connection budget must fit inside the role limit');
assert(maintenanceLock.includes("role === AUTOMATION_ROLE ? AUTOMATION_DEFAULT_LOCK_POOL_MAX : 12"),
    'Automation worker must use its smaller maintenance-lock pool default without reducing the web mutation guard pool');
assert(maintenanceLock.includes('availableForLocks = AUTOMATION_ROLE_CONNECTION_LIMIT - primaryPoolMax - AUTOMATION_NON_POOL_RESERVE'),
    'Automation maintenance-lock capacity must be derived from remaining role headroom');
assert(maintenanceLock.includes('Unsafe automation database pool budget') && maintenanceLock.includes('Unsafe automation maintenance-lock pool'),
    'Unsafe custom automation pool sizes must fail fast instead of exhausting the role during jobs');

const managedStremio = read('src/stremio/managed-entitlements.js');
const managedSyncScope = managedStremio.slice(managedStremio.indexOf('async function syncActive'), managedStremio.indexOf('module.exports'));
assert(managedSyncScope.includes('await mappings(entitlement)'),
    'managed Stremio automation must reuse policy-ready mappings instead of rewriting every active account policy on every run');
assert(!managedSyncScope.includes('for(const account of accounts)await applyPolicy(account,effective,false)'),
    'managed Stremio automation must not unconditionally POST policy for every active hidden account');
assert(managedStremio.includes('const failureReasons=new Map()') && managedStremio.includes('summarizeFailures(failureReasons'),
    'managed Stremio automation must preserve concrete sub-operation failure reasons');
assert(managedStremio.includes('warning=[revocation.warning,syncWarning].filter(Boolean)'),
    'managed Stremio automation must return a warning that job health can display');

const resilientProvisioning = read('src/jellyfin/resilient-provisioning.js');
const policyGuardScope = resilientProvisioning.slice(
    resilientProvisioning.indexOf('async function applyPolicyIfChanged'),
    resilientProvisioning.indexOf('async function disableAccounts')
);
assert(policyGuardScope.includes("method:'GET',timeoutMs:5000"),
    'entitlement reconciliation must probe the current remote policy before issuing a write');
assert(policyGuardScope.includes('control.policyMatches(remote,desired)'),
    'entitlement reconciliation must recognize an unchanged remote policy');
assert(policyGuardScope.includes('return{missing:[],unchanged:true}'),
    'unchanged entitlement policy must complete without a remote policy POST');
assert(policyGuardScope.indexOf('control.policyMatches(remote,desired)') < policyGuardScope.indexOf('return base.applyPolicy(account,effective,disabled)'),
    'policy comparison must happen before the fallback policy mutation');
const laneScope = resilientProvisioning.slice(
    resilientProvisioning.indexOf('async function reconcileLane'),
    resilientProvisioning.indexOf('async function recordRun')
);
assert(laneScope.includes('await applyPolicyIfChanged(account,effective,false)'),
    'active entitlement lanes must use the read-before-write policy guard');
assert(!laneScope.includes('await base.applyPolicy(account,effective,false)'),
    'active entitlement lanes must not unconditionally POST policy on every verification run');

const admin = read('src/platform/admin-automation.js');
assert(admin.includes("state==='degraded'"), 'Automation UI must render degraded state');
assert(admin.includes('Failed sub-operations'), 'Automation UI must expose partial failure count');

console.log('automation/release hardening smoke passed');
