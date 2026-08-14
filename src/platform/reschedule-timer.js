'use strict';

// A recurring job whose delay is re-read from getDelayMs() on every cycle,
// instead of setInterval's delay which is fixed at creation time. This lets
// an admin Settings change (which updates the value getDelayMs reads) take
// effect on the job's very next run, with no process restart.

function createRescheduler(task, getDelayMs, opts = {}) {
    const scheduleTimeout = opts.setTimeout || setTimeout;
    const clearScheduledTimeout = opts.clearTimeout || clearTimeout;
    let timer = null;
    let stopped = false;

    function scheduleNext() {
        if (stopped) return;
        const delay = Math.max(0, Number(getDelayMs()) || 0);
        timer = scheduleTimeout(async () => {
            try { await task(); }
            finally { scheduleNext(); }
        }, delay);
        if (timer && typeof timer.unref === 'function') timer.unref();
    }

    function start() { scheduleNext(); }
    function stop() { stopped = true; if (timer) clearScheduledTimeout(timer); }

    return { start, stop };
}

module.exports = { createRescheduler };
