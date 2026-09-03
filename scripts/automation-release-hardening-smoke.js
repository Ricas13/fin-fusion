'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const jobHealth = require('../src/automation/job-health');
const connectionBudget = require('../src/security/database-connection-budget');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const compact = value => String(value || '').replace(/\s+/g, '');

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
assert(worker.includes('dbConnectionBudget') && worker.includes('CONNECTION_BUDGET.totalReserved'),
    'Automation heartbeat metadata must expose the complete database connection budget');
assert(worker.includes('Automation request-service settings refresh failed during startup'),
    'Best-effort automation settings refresh failures must remain visible to operators');

const compose = read('docker-compose.yml');
const roleScript = read('scripts/configure-runtime-db-roles.js');
const maintenanceLock = read('src/security/maintenance-lock.js');
const reconciliationLock = read('src/jellyfin/reconciliation-lock.js');
const automationRoleLimit = Number(/automation:\s*\{[^}]*connectionLimit:\s*(\d+)/s.exec(roleScript)?.[1]);
const automationPoolDefault = Number(/AUTOMATION_DB_POOL_SIZE:-([0-9]+)/.exec(compose)?.[1]);
assert(Number.isFinite(automationRoleLimit), 'Automation database role must have an explicit connection limit');
assert(Number.isFinite(automationPoolDefault), 'Compose must expose the automation primary pool default');
assert.strictEqual(connectionBudget.AUTOMATION_ROLE_CONNECTION_LIMIT, automationRoleLimit,
    'Shared connection budget must track the PostgreSQL automation role connection limit');

const defaultAutomationBudget = connectionBudget.automationConnectionBudget({
    DB_POOL_SIZE: String(automationPoolDefault),
    AUTOMATION_RECONCILIATION_MAX_CONCURRENCY: String(connectionBudget.AUTOMATION_DEFAULT_RECONCILIATION_MAX)
});
assert.strictEqual(defaultAutomationBudget.primaryPoolMax, 6, 'automation primary pool default should remain six');
assert.strictEqual(defaultAutomationBudget.maintenanceLockPoolMax, 4, 'automation maintenance-lock default should remain four');
assert.strictEqual(defaultAutomationBudget.reconciliationMax, 1, 'automation reconciliation must reserve only one dedicated lock connection by default');
assert.strictEqual(defaultAutomationBudget.healthcheckReserve, 1, 'automation healthcheck must retain a dedicated connection reserve');
assert(defaultAutomationBudget.totalReserved <= automationRoleLimit,
    'Default automation primary + maintenance + reconciliation + healthcheck budget must fit inside the role limit');
assert.strictEqual(defaultAutomationBudget.spare, 0, 'the default automation budget should account for every role connection explicitly');
assert.strictEqual(connectionBudget.automationConnectionBudget({
    DB_POOL_SIZE: '6',
    RECONCILIATION_MAX_CONCURRENCY: '4'
}).reconciliationMax, 1,
'web reconciliation configuration must not leak into the automation role budget');
assert.throws(() => connectionBudget.automationConnectionBudget({
    DB_POOL_SIZE: '6',
    AUTOMATION_RECONCILIATION_MAX_CONCURRENCY: '4'
}), /Unsafe automation database pool budget/,
'unsafe automation reconciliation concurrency must fail fast instead of oversubscribing the automation role');
assert.throws(() => connectionBudget.automationConnectionBudget({
    DB_POOL_SIZE: '6',
    AUTOMATION_RECONCILIATION_MAX_CONCURRENCY: '1',
    AUTOMATION_MAINTENANCE_LOCK_POOL_MAX: '5'
}), /Unsafe automation maintenance-lock pool/,
'unsafe explicit maintenance-lock concurrency must fail fast instead of oversubscribing the automation role');
assert(maintenanceLock.includes('automationConnectionBudget().maintenanceLockPoolMax'),
    'Maintenance locks must consume the shared automation connection budget');
assert(reconciliationLock.includes('automationConnectionBudget().reconciliationMax'),
    'Customer reconciliation must consume the shared automation connection budget');

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
const managedApplyScope = managedStremio.slice(
    managedStremio.indexOf('async function applyPolicy'),
    managedStremio.indexOf('async function createMapping')
);
assert(managedApplyScope.includes("method:'GET',timeoutMs:5000"),
    'managed Stremio policy maintenance must read the remote hidden-account policy before writing');
assert(managedApplyScope.includes('policyControl.policyMatches(remote,body)'),
    'managed Stremio policy maintenance must suppress unchanged remote policy writes');
assert(managedApplyScope.indexOf('policyControl.policyMatches(remote,body)') < managedApplyScope.indexOf("method:'POST',body"),
    'managed Stremio policy comparison must happen before the policy mutation');

const resilientProvisioning = read('src/jellyfin/resilient-provisioning.js');
const policyGuardScope = resilientProvisioning.slice(
    resilientProvisioning.indexOf('async function applyPolicyIfChanged'),
    resilientProvisioning.indexOf('async function disableAccounts')
);
const compactPolicyGuardScope = compact(policyGuardScope);
assert(compactPolicyGuardScope.includes("method:'GET',timeoutMs:5000"),
    'entitlement reconciliation must probe the current remote policy before issuing a write');
assert(compactPolicyGuardScope.includes('control.policyMatches(remote,desired)'),
    'entitlement reconciliation must recognize an unchanged remote policy');
assert(compactPolicyGuardScope.includes('return{missing:[],unchanged:true}'),
    'unchanged entitlement policy must complete without a remote policy POST');
assert(compactPolicyGuardScope.indexOf('control.policyMatches(remote,desired)') < compactPolicyGuardScope.indexOf('returnbase.applyPolicy(account,effective,disabled)'),
    'policy comparison must happen before the fallback policy mutation');
const laneScope = resilientProvisioning.slice(
    resilientProvisioning.indexOf('async function reconcileLane'),
    resilientProvisioning.indexOf('async function recordRun')
);
const compactLaneScope = compact(laneScope);
assert(compactLaneScope.includes('awaitapplyPolicyIfChanged(account,effective,false)'),
    'active entitlement lanes must use the read-before-write policy guard');
assert(!compactLaneScope.includes('awaitbase.applyPolicy(account,effective,false)'),
    'active entitlement lanes must not unconditionally POST policy on every verification run');

const admin = read('src/platform/admin-automation.js');
assert(admin.includes("state==='degraded'"), 'Automation UI must render degraded state');
assert(admin.includes('Failed sub-operations'), 'Automation UI must expose partial failure count');

console.log('automation/release hardening smoke passed');
