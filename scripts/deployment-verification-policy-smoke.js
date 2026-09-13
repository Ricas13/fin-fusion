'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const verifier = require('./verify-deployment');
const criticalJobs = require('../src/automation/critical-jobs');

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

assert.strictEqual(criticalJobs.isCritical('customer_inactivity'), true,
    'customer inactivity cleanup must remain registered as access-critical capability');
assert.strictEqual(criticalJobs.mayBeDisabled('customer_inactivity'), true,
    'customer inactivity cleanup must support intentional operator disablement');
assert.strictEqual(criticalJobs.mayBeDisabled('revenue_integrity'), false,
    'revenue integrity must remain required-enabled');

const source = fs.readFileSync(path.join(__dirname, 'verify-deployment.js'), 'utf8');
assert(source.includes('workerStartedAt: automationWorker.started_at'),
    'deployment recovery proof must be anchored to the current automation worker start');
assert(source.includes('AND draining_at IS NULL'),
    'deployment verification must ignore worker instances that are already draining');
assert(source.includes("add('critical automation job enablement'"),
    'deployment verification must distinguish missing critical jobs from unexpected disablement');
assert(source.includes("add('Free Server inactivity cleanup policy'"),
    'inactivity cleanup must be reported as an operator policy rather than the whole Free Server lifecycle');
assert(!source.includes("add('Free Server lifecycle job'"),
    'the misleading Free Server lifecycle job blocker label must not return');
assert(source.includes('if (require.main === module)'),
    'deployment verifier must be import-safe so release-policy helpers can be tested without running production checks');

console.log('deployment verification policy smoke: ok');
