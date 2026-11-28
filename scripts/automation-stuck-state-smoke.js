'use strict';

// Stuck job detection, every place that classifies job health, and the guard
// that stops a force request from running a disabled job. No database needed.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');

const statements = [];
let configRow = null;
let updatedRows = 1;

async function runStatement(sql, params) {
    statements.push({ sql, params });
    if (sql.startsWith('SELECT * FROM automation_job_state WHERE job_key')) {
        return { rows: configRow ? [configRow] : [], rowCount: configRow ? 1 : 0 };
    }
    if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }], rowCount: 1 };
    return { rows: updatedRows ? [{ job_key: params?.[0] }] : [], rowCount: updatedRows };
}

const originalLoad = Module._load;
Module._load = function load(request, parent, ...rest) {
    if (request === '../db' && /job-health\.js$/.test(parent?.filename || '')) {
        return {
            query: runStatement,
            getPool: () => ({ connect: async () => ({ query: runStatement, release() {} }) })
        };
    }
    return originalLoad.call(this, request, parent, ...rest);
};
const jobHealth = require('../src/automation/job-health');
Module._load = originalLoad;

const jobRegistry = require('../src/automation/jobs');
const automationPage = require('../src/platform/admin-automation');
const controlCenter = require('../src/platform/admin-dashboard-control-center');
const attentionPolicy = require('../src/platform/actionable-attention-policy');

const now = Date.now();
const ago = seconds => new Date(now - seconds * 1000);
const running = (job_key, seconds, interval_seconds = 300) => ({
    job_key, enabled: true, interval_seconds, last_outcome: 'success',
    last_started_at: ago(seconds), last_completed_at: ago(seconds + 600), last_success_at: ago(seconds + 600)
});
const state = row => jobHealth.healthState(row, now);

assert.strictEqual(state(running('billing', 29 * 60)), 'running');
assert.strictEqual(state(running('billing', 30 * 60)), 'running', 'the limit itself is not yet exceeded');
assert.strictEqual(state(running('billing', 30 * 60 + 1)), 'stuck');
assert.strictEqual(state(running('discord_roles', 35 * 3600, 43200)), 'running', 'three intervals apply to slow schedules');
assert.strictEqual(state(running('discord_roles', 37 * 3600, 43200)), 'stuck');
assert.strictEqual(state(running('stremio_media_index', 59 * 60)), 'running', 'the media index may run for an hour');
assert.strictEqual(state(running('stremio_media_index', 61 * 60)), 'stuck');
assert.strictEqual(state({ job_key: 'billing', enabled: true, last_started_at: ago(7200) }), 'stuck',
    'a first run that never completed can be stuck');
assert.strictEqual(state({ ...running('billing', 7200), last_completed_at: ago(7100) }), 'stale',
    'a completed run is never stuck');
assert.strictEqual(state({ ...running('billing', 7200), enabled: false }), 'disabled');
assert.strictEqual(jobRegistry.definition('stremio_media_index').maxRunSeconds, 3600);
assert.strictEqual(jobHealth.stuckAfterSeconds({ job_key: 'stremio_media_index', interval_seconds: 300 }), 3600);

const stuckBilling = running('billing', 7200);
const healthyHealth = {
    job_key: 'health', enabled: true, interval_seconds: 300, last_outcome: 'success',
    last_started_at: ago(60), last_completed_at: ago(50), last_success_at: ago(50)
};

const card = automationPage.jobCard({ session: {} }, stuckBilling);
assert(card.includes('<span class="pill bad">stuck</span>'), 'the automation page must show a stuck job as bad');
const heroActions = jobs => automationPage.automationHero(jobs, { heartbeat_age_seconds: 5 }, true);
assert(heroActions([stuckBilling, healthyHealth]).includes('Fix unhealthy jobs'), 'a stuck job must be offered for repair');
assert(!heroActions([healthyHealth]).includes('Fix unhealthy jobs'));

const snapshot = controlCenter.automationSnapshot(jobRegistry.criticalNames().map(job_key =>
    (job_key === 'billing' ? stuckBilling : { ...healthyHealth, job_key })));
assert.deepStrictEqual(snapshot.warnings.map(item => [item.key, item.state]), [['billing', 'stuck']],
    'the dashboard must warn about a stuck critical job');
assert.strictEqual(snapshot.running, 0);
assert.strictEqual(snapshot.healthy, snapshot.total - 1);

assert.deepStrictEqual(attentionPolicy.jobDecision(stuckBilling, 'stuck'),
    { visible: true, severity: 'critical', reason: 'stuck' });
assert.strictEqual(attentionPolicy.jobDecision({ job_key: 'bulk_jobs' }, 'stuck').severity, 'warning');

// Every hand-written list of unhealthy job states must name stuck wherever it names stale.
for (const file of ['admin-automation.js', 'admin-dashboard-control-center.js', 'admin-configuration-health.js']) {
    const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', file), 'utf8');
    const lists = source.match(/\[[^\]\n]*'stale'[^\]\n]*\]/g) || [];
    assert(lists.length > 0, `${file} must still classify job states`);
    for (const list of lists) assert(list.includes("'stuck'"), `${file} omits stuck from ${list}`);
}

async function disabledForceGuard() {
    configRow = { enabled: true };
    updatedRows = 0;
    assert.strictEqual(await jobHealth.requestRun('billing', { enabledOnly: true }), null);
    assert(statements.at(-1).sql.includes('AND enabled=TRUE'));
    await assert.rejects(jobHealth.requestRun('missing'), /Automation job not found/);
    assert(!statements.at(-1).sql.includes('AND enabled=TRUE'), 'an operator can still run a disabled job once');
    updatedRows = 1;

    await jobHealth.update('billing', { enabled: false, intervalSeconds: 300 });
    assert(statements.at(-1).sql.includes('force_run_requested=CASE WHEN $2 THEN force_run_requested ELSE FALSE END'),
        'disabling a job must withdraw a pending forced run');

    let runs = 0;
    const attempt = options => jobHealth.runSingleton('billing', async () => { runs += 1; return {}; }, options);
    configRow = { enabled: false, force_run_requested: false };
    assert.deepStrictEqual(await attempt({ force: true }), { skipped: true, reason: 'disabled' },
        'a force request withdrawn by disabling must not run');
    assert.deepStrictEqual(await attempt({}), { skipped: true, reason: 'disabled' });
    assert.strictEqual(runs, 0);
    configRow = { enabled: false, force_run_requested: true };
    assert.strictEqual((await attempt({ force: true })).ok, true, 'a pending operator run still executes once');
    configRow = { enabled: true, force_run_requested: false };
    assert.strictEqual((await attempt({})).ok, true);
    assert.strictEqual(runs, 2);
}

disabledForceGuard().then(() => {
    console.log('automation stuck state smoke: ok');
    process.exit(0);
}).catch(error => {
    console.error(error);
    process.exit(1);
});
