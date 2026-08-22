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

const admin = read('src/platform/admin-automation.js');
assert(admin.includes("state==='degraded'"), 'Automation UI must render degraded state');
assert(admin.includes('Failed sub-operations'), 'Automation UI must expose partial failure count');

console.log('automation/release hardening smoke passed');
