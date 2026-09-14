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

async function permit(fn) {
    const limit = jobConcurrency();
    if (active >= limit) await new Promise(resolve => waiting.push(resolve));
    active += 1;
    try { return await fn(); }
    finally {
        active = Math.max(0, active - 1);
        const next = waiting.shift();
        if (next) next();
    }
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

module.exports = {
    DEFAULT_JOB_DB_CONCURRENCY,
    DEFAULT_REQUEST_USER_SYNC_CONCURRENCY,
    jobConcurrency,
    install,
    transientDatabasePressure
};
