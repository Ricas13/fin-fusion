'use strict';

const DEFAULT_JOB_DB_CONCURRENCY = 2;
const DEFAULT_REQUEST_USER_SYNC_CONCURRENCY = 2;
let active = 0;
const waiting = [];
let installed = false;

function bounded(value, fallback, min, max) {
    const parsed = Number.parseInt(value == null ? '' : String(value), 10);
    return Number.isInteger(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function jobConcurrency(env = process.env) {
    const pool = bounded(env.DB_POOL_SIZE, 6, 1, 80);
    return bounded(env.AUTOMATION_JOB_DB_CONCURRENCY, DEFAULT_JOB_DB_CONCURRENCY, 1, Math.max(1, pool - 2));
}

async function acquire(limit) {
    if (active < limit) {
        active += 1;
        return;
    }
    await new Promise(resolve => waiting.push(resolve));
}

function release() {
    const next = waiting.shift();
    if (next) {
        // Transfer the existing permit directly to the next waiter. Keeping the
        // active count unchanged avoids a release/reacquire race that could
        // briefly exceed the configured concurrency.
        next();
        return;
    }
    active = Math.max(0, active - 1);
}

async function permit(fn) {
    await acquire(jobConcurrency());
    try { return await fn(); }
    finally { release(); }
}

function guarded(fn) {
    return function guardedDatabaseOperation(...args) {
        return permit(() => fn.apply(this, args));
    };
}

function install(db, env = process.env) {
    if (!String(env.REQUEST_USER_SYNC_CONCURRENCY || '').trim()) {
        env.REQUEST_USER_SYNC_CONCURRENCY = String(DEFAULT_REQUEST_USER_SYNC_CONCURRENCY);
    }
    if (installed) return;
    // Patch the shared db exports before the automation job modules are loaded.
    // The worker scheduler itself imports its control-plane query before this
    // install runs, so heartbeat/scheduling retains the pool headroom reserved
    // by scripts/automation-worker.js.
    for (const name of ['query', 'readQuery', 'mutationQuery']) {
        if (typeof db[name] === 'function') db[name] = guarded(db[name]);
    }
    installed = true;
}

function transientDatabasePressure(value) {
    const message = String(value || '').toLowerCase();
    return message.includes('timeout exceeded when trying to connect')
        || message.includes('db_pool_saturated')
        || message.includes('database is temporarily busy');
}

function metrics() {
    return { installed, active, waiting: waiting.length, concurrency: jobConcurrency() };
}

module.exports = {
    DEFAULT_JOB_DB_CONCURRENCY,
    DEFAULT_REQUEST_USER_SYNC_CONCURRENCY,
    jobConcurrency,
    install,
    transientDatabasePressure,
    metrics
};
