'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { nonCriticalSlotLimit, selectDispatchable, createDispatchWake } = require('../src/automation/dispatch-policy');
const jobRegistry = require('../src/automation/jobs');

const rows = (...keys) => keys.map(job_key => ({ job_key }));
const select = (keys, { max = 3, running = [] } = {}) => selectDispatchable(rows(...keys), {
    capacity: Math.max(0, max - running.length),
    maxConcurrency: max,
    runningJobKeys: new Set(running),
    isCritical: jobKey => jobKey.startsWith('critical')
}).map(row => row.job_key);

assert.strictEqual(nonCriticalSlotLimit(1), 1);
assert.strictEqual(nonCriticalSlotLimit(2), 1);
assert.strictEqual(nonCriticalSlotLimit(3), 2);

assert.deepStrictEqual(select(['slow-1', 'slow-2', 'slow-3', 'critical-1']), ['slow-1', 'slow-2', 'critical-1'],
    'a later critical job must take the slot withheld from non-critical work');
assert.deepStrictEqual(select(['slow-3', 'slow-4'], { running: ['slow-1', 'slow-2'] }), [],
    'non-critical jobs must not take the last slot');
assert.deepStrictEqual(select(['slow-3', 'critical-1'], { running: ['slow-1', 'slow-2'] }), ['critical-1']);
assert.deepStrictEqual(select(['critical-1', 'critical-2', 'critical-3', 'critical-4']),
    ['critical-1', 'critical-2', 'critical-3'], 'critical jobs may use every slot and never exceed capacity');
assert.deepStrictEqual(select(['slow-1', 'slow-2'], { running: ['critical-1', 'critical-2'] }), ['slow-1'],
    'running critical jobs must not count against the non-critical allowance');
assert.deepStrictEqual(select(['slow-1', 'slow-2', 'critical-1'], { max: 2 }), ['slow-1', 'critical-1']);
assert.deepStrictEqual(select(['slow-2'], { max: 2, running: ['slow-1'] }), []);

assert.deepStrictEqual(select(['slow-1', 'critical-1'], { max: 1 }), ['slow-1'],
    'a single dispatcher slot keeps due-order scheduling');
assert.deepStrictEqual(select(['critical-1', 'slow-1'], { max: 1 }), ['critical-1']);
assert.deepStrictEqual(select(['slow-1'], { max: 1, running: ['critical-1'] }), []);

assert.deepStrictEqual(select(['critical-1', 'critical-1', 'critical-2'], { running: ['critical-2'] }), ['critical-1'],
    'running or repeated job keys must not be dispatched twice');

assert.strictEqual(jobRegistry.isCritical('stremio_media_index'), false);
assert.strictEqual(jobRegistry.isCritical('customer_inactivity'), true);
assert.deepStrictEqual(selectDispatchable(
    rows('stremio_media_index', 'data_retention', 'bulk_jobs', 'customer_inactivity'),
    { capacity: 3, maxConcurrency: 3, runningJobKeys: [], isCritical: jobRegistry.isCritical }
).map(row => row.job_key), ['stremio_media_index', 'data_retention', 'customer_inactivity']);

assert.deepStrictEqual(jobRegistry.names().filter(jobKey => jobRegistry.definition(jobKey).hostLocks),
    ['stremio_media_index'], 'only the media index job may carry its locks on the job client');

const worker = fs.readFileSync(path.join(__dirname, 'automation-worker.js'), 'utf8');
assert(worker.includes('dispatchPolicy.selectDispatchable(rows, {') && worker.includes('isCritical: jobRegistry.isCritical'),
    'automation worker must dispatch through the shared lane policy');
assert(worker.includes('hostLocks: Boolean(jobRegistry.definition(jobKey)?.hostLocks)'),
    'automation worker must pass the registry host-lock policy to the singleton runner');

assert(worker.includes('dispatchWake.beginCycle(runningJobs);') && worker.includes('dispatchWake.noteStarted(jobKey);')
    && worker.includes('dispatchWake.wake();'),
    'automation worker must refill freed slots through the bounded dispatcher wake');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// A two-slot dispatcher over a job table where finished jobs stay in the table
// as due only when they are marked as always due.
async function wakeBehaviour() {
    const due = new Set(Array.from({ length: 8 }, (_, index) => `forced-${index}`).concat('always-due'));
    const running = new Set();
    const launches = [];
    let stopping = false;
    let failNextLoad = false;
    const errors = [];
    const wake = createDispatchWake({
        loadDue: async () => {
            if (failNextLoad) { failNextLoad = false; throw new Error('database unavailable'); }
            return rows(...due);
        },
        dispatch,
        isStopping: () => stopping,
        onError: error => errors.push(error.message),
        delayMs: 2
    });
    function dispatch(list) {
        for (const row of selectDispatchable(list, {
            capacity: 2 - running.size, maxConcurrency: 2, runningJobKeys: running, isCritical: () => true
        })) {
            const jobKey = row.job_key;
            running.add(jobKey);
            wake.noteStarted(jobKey);
            launches.push(jobKey);
            setTimeout(() => {
                running.delete(jobKey);
                if (jobKey !== 'always-due') due.delete(jobKey);
                wake.wake();
            }, 5);
        }
    }

    wake.beginCycle(running);
    dispatch(rows('always-due', ...[...due].filter(key => key !== 'always-due')));
    await sleep(400);
    assert.strictEqual(launches.length, 9, 'every queued row must run within one poll cycle');
    assert.strictEqual(new Set(launches).size, 9);
    await sleep(60);
    assert.strictEqual(launches.length, 9, 'a job that stays due must not be restarted by wakes');

    wake.beginCycle(running);
    due.add('forced-next');
    failNextLoad = true;
    wake.wake();
    await sleep(30);
    assert.deepStrictEqual(errors, ['database unavailable']);
    wake.wake();
    await sleep(60);
    assert.deepStrictEqual(launches.slice(9).sort(), ['always-due', 'forced-next'], 'a failed wake must not disable later wakes');

    wake.beginCycle(running);
    stopping = true;
    due.add('after-stop');
    wake.wake();
    await sleep(30);
    assert(!launches.includes('after-stop'), 'a draining worker must not be woken');
}

wakeBehaviour().then(() => {
    console.log('automation dispatch lanes smoke: ok');
    process.exit(0);
}).catch(error => {
    console.error(error);
    process.exit(1);
});
