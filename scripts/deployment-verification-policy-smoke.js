'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const verifier = require('./verify-deployment');
const jobRegistry = require('../src/automation/jobs');

const workerStartedAt = '2026-09-13T12:00:00.000Z';

assert.strictEqual(verifier.probeSucceededSince({
    last_outcome: 'success',
    last_success_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), true, 'a successful recovery run after worker startup must prove the deployed release');

assert.strictEqual(verifier.probeSucceededSince({
    last_outcome: 'success',
    last_success_at: '2026-09-13T11:59:59.000Z'
}, workerStartedAt), false, 'a success from the previous worker/release must not satisfy deployment proof');

assert.strictEqual(verifier.probeSucceededSince({
    last_outcome: 'degraded',
    last_success_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), false, 'a later degraded outcome must fail closed even when an earlier success is recent');

assert.strictEqual(verifier.probeSatisfiedSince('revenue_integrity', {
    last_outcome: 'degraded',
    last_completed_at: '2026-09-13T12:00:05.000Z',
    last_success_at: '2026-09-12T12:00:05.000Z'
}, workerStartedAt), true,
'revenue integrity degraded means the scanner completed under this release and must be handed to operator acceptance rather than treated as an execution failure');

assert.strictEqual(verifier.probeSatisfiedSince('customer_service_recovery', {
    last_outcome: 'degraded',
    last_completed_at: '2026-09-13T12:00:05.000Z',
    last_success_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), false,
'other critical recovery jobs must continue to fail closed on degraded outcomes');

assert.strictEqual(verifier.probeSatisfiedSince('revenue_integrity', {
    last_outcome: 'failed',
    last_completed_at: '2026-09-13T12:00:05.000Z'
}, workerStartedAt), false,
'a failed revenue integrity execution must still block deployment');

assert.strictEqual(verifier.deploymentJobBlocks('revenue_integrity', 'degraded'), false,
'revenue integrity findings belong to production acceptance rather than deployment rollback');
assert.strictEqual(verifier.deploymentJobBlocks('revenue_integrity', 'failed'), true,
'revenue integrity execution failures must still block deployment');
assert.strictEqual(verifier.deploymentJobBlocks('billing', 'degraded'), true,
'degraded non-integrity critical jobs must remain deployment blockers');

const diagnostic = verifier.formatProbeSnapshot({
    jobKey: 'revenue_integrity',
    state: 'healthy',
    successAt: '2026-09-13T12:00:05.000Z',
    completedAt: '2026-09-13T12:00:05.000Z',
    lastStartedAt: '2026-09-13T12:00:04.000Z',
    forceRunRequested: false,
    requiredSince: workerStartedAt
});
for (const token of ['state=healthy', 'success=', 'completed=', 'started=', 'force=false', 'required_since=']) {
    assert(diagnostic.includes(token), `timeout diagnostics must include ${token}`);
}

assert.strictEqual(jobRegistry.isCritical('customer_inactivity'), true,
    'customer inactivity cleanup must remain registered as access-critical capability');
assert.strictEqual(jobRegistry.mayBeDisabled('customer_inactivity'), true,
    'customer inactivity cleanup must support intentional operator disablement');
assert.strictEqual(jobRegistry.mayBeDisabled('revenue_integrity'), false,
    'revenue integrity must remain required-enabled');
assert(verifier.DEPLOYMENT_PROBE_JOBS.includes('free_capacity_backfill'),
    'free-capacity recovery must be explicitly proved under the candidate worker before cutover');

const staleBeforeRestart={
    enabled:true,
    interval_seconds:300,
    last_started_at:'2026-09-13T11:30:00.000Z',
    last_completed_at:'2026-09-13T11:30:01.000Z',
    last_outcome:'success'
};
assert.strictEqual(
    verifier.deploymentCriticalState(staleBeforeRestart,'2026-09-13T12:00:00.000Z',new Date('2026-09-13T12:02:00.000Z').getTime()),
    'warming',
    'old stale state must get one scheduler interval to warm up after a fresh worker starts'
);
assert.strictEqual(
    verifier.deploymentCriticalState(staleBeforeRestart,'2026-09-13T12:00:00.000Z',new Date('2026-09-13T12:06:00.000Z').getTime()),
    'stale',
    'a critical job that remains stale beyond worker warm-up must still block deployment'
);

const source = fs.readFileSync(path.join(__dirname, 'verify-deployment.js'), 'utf8');
assert(source.includes('workerStartedAt: automationWorker.started_at'),
    'deployment recovery proof must be anchored to the current automation worker start');
assert(source.includes('AND draining_at IS NULL'),
    'deployment verification must ignore worker instances that are already draining');
assert(source.includes("add('critical automation job enablement'"),
    'deployment verification must distinguish missing critical jobs from unexpected disablement');
assert(source.includes("add('revenue integrity execution'"),
    'deployment verification must report revenue integrity as an explicit operator-attention lane');
assert(source.includes("add('Free Server inactivity cleanup policy'"),
    'inactivity cleanup must be reported as an operator policy rather than the whole Free Server lifecycle');
assert(source.includes("deploymentCriticalState(freeBackfillJob, automationWorker?.started_at)"),
    'free-capacity recovery health must honor candidate-worker warm-up semantics after restart');
assert(!source.includes("add('Free Server lifecycle job'"),
    'the misleading Free Server lifecycle job blocker label must not return');
assert(source.includes('if (require.main === module)'),
    'deployment verifier must be import-safe so release-policy helpers can be tested without running production checks');

console.log('deployment verification policy smoke: ok');
