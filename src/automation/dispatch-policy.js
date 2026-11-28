'use strict';

// With more than one dispatcher slot, one is kept free of non-critical work so
// slow background jobs cannot hold back access-critical automation.
function nonCriticalSlotLimit(maxConcurrency) {
    const max = Math.max(1, Number(maxConcurrency) || 1);
    return max > 1 ? max - 1 : max;
}

// Pure selection of the due rows to launch now, preserving their order.
function selectDispatchable(rows, { capacity, maxConcurrency, runningJobKeys = [], isCritical }) {
    const held = new Set(runningJobKeys);
    const nonCriticalLimit = nonCriticalSlotLimit(maxConcurrency);
    let nonCriticalHeld = [...held].filter(jobKey => !isCritical(jobKey)).length;
    const selected = [];
    for (const row of rows || []) {
        if (selected.length >= capacity) break;
        const jobKey = row.job_key;
        if (held.has(jobKey)) continue;
        if (!isCritical(jobKey)) {
            if (nonCriticalHeld >= nonCriticalLimit) continue;
            nonCriticalHeld += 1;
        }
        held.add(jobKey);
        selected.push(row);
    }
    return selected;
}

// Dispatches again as soon as a job frees a slot, so queued rows do not wait for
// the next poll. A wake never starts a job already started in the current poll
// cycle, which bounds the work per cycle and rules out a busy loop.
function createDispatchWake({ loadDue, dispatch, isStopping = () => false, onError = () => {}, delayMs = 250 }) {
    let startedThisCycle = new Set();
    let timer = null;

    async function run() {
        try {
            if (isStopping()) return;
            const due = (await loadDue()).filter(row => !startedThisCycle.has(row.job_key));
            if (due.length && !isStopping()) dispatch(due);
        } catch (error) {
            onError(error);
        } finally {
            timer = null;
        }
    }

    return {
        beginCycle(runningJobKeys = []) { startedThisCycle = new Set(runningJobKeys); },
        noteStarted(jobKey) { startedThisCycle.add(jobKey); },
        // Calls made while a wake is pending are covered by it.
        wake() {
            if (timer || isStopping()) return;
            timer = setTimeout(run, delayMs);
            timer.unref?.();
        }
    };
}

module.exports = { nonCriticalSlotLimit, selectDispatchable, createDispatchWake };
