'use strict';

const assert = require('assert');
const { createRescheduler } = require('../src/platform/reschedule-timer');

function fakeClock() {
    const pending = [];
    return {
        pending,
        setTimeout(fn, delay) {
            const handle = { fn, delay, cancelled: false };
            pending.push(handle);
            return handle;
        },
        clearTimeout(handle) { handle.cancelled = true; },
        async fireNext() {
            const handle = pending.shift();
            if (!handle || handle.cancelled) return handle;
            await handle.fn();
            return handle;
        }
    };
}

async function main() {
    // The delay for a cycle is read from getDelayMs() when that cycle is
    // scheduled: once at start(), and again right after every task completes
    // (inside the finally block, before the next cycle's timer is created). A
    // settings change made before a task completes is therefore picked up by
    // the timer scheduled immediately after -- the property setInterval lacks,
    // since its delay is fixed forever at creation time.
    const clock = fakeClock();
    let delayMs = 5000;
    let runs = 0;
    const rescheduler = createRescheduler(
        () => { runs += 1; },
        () => delayMs,
        { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
    );

    rescheduler.start();
    assert.strictEqual(clock.pending[0].delay, 5000, 'first cycle should use the delay in effect at start');

    await clock.fireNext();
    assert.strictEqual(runs, 1, 'task should run on schedule');
    assert.strictEqual(clock.pending[0].delay, 5000, 'cycle scheduled before the settings change keeps the old delay');

    delayMs = 1000;
    await clock.fireNext();
    assert.strictEqual(runs, 2);
    assert.strictEqual(clock.pending[0].delay, 1000, 'cycle scheduled after a settings change must use the new delay, not the one fixed at creation time');

    // A throwing task must not break the reschedule loop.
    const clock2 = fakeClock();
    let failingRuns = 0;
    const failingRescheduler = createRescheduler(
        () => { failingRuns += 1; throw new Error('boom'); },
        () => 2000,
        { setTimeout: clock2.setTimeout, clearTimeout: clock2.clearTimeout }
    );
    failingRescheduler.start();
    await clock2.fireNext().catch(() => {});
    assert.strictEqual(failingRuns, 1);
    assert.strictEqual(clock2.pending[0].delay, 2000, 'the loop must reschedule even after a task throws');

    // stop() must prevent further scheduling.
    const clock3 = fakeClock();
    let stoppedRuns = 0;
    const stoppableRescheduler = createRescheduler(
        () => { stoppedRuns += 1; },
        () => 3000,
        { setTimeout: clock3.setTimeout, clearTimeout: clock3.clearTimeout }
    );
    stoppableRescheduler.start();
    stoppableRescheduler.stop();
    const cancelled = await clock3.fireNext();
    assert.strictEqual(cancelled.cancelled, true, 'stop() should cancel the pending timer');

    console.log('Reschedulable timer smoke test passed.');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
