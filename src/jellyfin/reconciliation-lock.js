'use strict';

const { AsyncLocalStorage } = require('async_hooks');
const { Client } = require('pg');
const {
    AUTOMATION_ROLE,
    AUTOMATION_DEFAULT_RECONCILIATION_MAX,
    boundedInteger,
    databaseRole,
    automationConnectionBudget
} = require('../security/database-connection-budget');

const LOCK_NAMESPACE = 761932;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_POLL_MS = 100;
const DEFAULT_MAX_CONCURRENCY = 4;
const NESTED_WAIT_WARNING_MS = 30000;

function reconciliationConcurrencyLimit() {
    const role = databaseRole(process.env.DATABASE_URL);
    if (role === AUTOMATION_ROLE) {
        return automationConnectionBudget().reconciliationMax;
    }
    return boundedInteger(
        process.env.RECONCILIATION_MAX_CONCURRENCY,
        DEFAULT_MAX_CONCURRENCY,
        1,
        50
    );
}

const MAX_CONCURRENCY = reconciliationConcurrencyLimit();
let activeSlots = 0;
const slotWaiters = [];
// The database session, and the nesting level, that own a lock in the current
// async call chain. Nested locks run on that session instead of waiting for a
// second process slot behind callers which are themselves waiting to nest.
const lockSession = new AsyncLocalStorage();
const metrics = {
    started: 0,
    succeeded: 0,
    failed: 0,
    lockTimeouts: 0,
    cleanupFailures: 0,
    totalDurationMs: 0,
    totalProcessSlotWaitMs: 0,
    totalDatabaseLockWaitMs: 0,
    maxDurationMs: 0,
    maxProcessSlotWaitMs: 0,
    maxDatabaseLockWaitMs: 0,
    lastDurationMs: null,
    lastProcessSlotWaitMs: null,
    lastDatabaseLockWaitMs: null,
    lastFinishedAt: null,
    lastErrorCode: null
};

function cleanCustomerId(value) {
    const id = String(value || '').trim();
    if (!id) throw new Error('Customer id is required for reconciliation locking.');
    return id;
}

function clientConfig() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required for reconciliation locking.');
    return {
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.DB_SSL === 'true'
            ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
            : false
    };
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function acquireProcessSlot() {
    if (activeSlots < MAX_CONCURRENCY) {
        activeSlots += 1;
        return;
    }
    await new Promise(resolve => slotWaiters.push(resolve));
}

function releaseProcessSlot() {
    const next = slotWaiters.shift();
    if (next) {
        // Transfer the existing active permit directly to the queued caller.
        next();
        return;
    }
    activeSlots = Math.max(0, activeSlots - 1);
}

function concurrencySnapshot() {
    return {
        active: activeSlots,
        queued: slotWaiters.length,
        limit: MAX_CONCURRENCY
    };
}

function metricsSnapshot() {
    const finished = metrics.succeeded + metrics.failed;
    return {
        ...metrics,
        averageDurationMs: finished ? Math.round(metrics.totalDurationMs / finished) : 0,
        averageProcessSlotWaitMs: finished ? Math.round(metrics.totalProcessSlotWaitMs / finished) : 0,
        averageDatabaseLockWaitMs: finished ? Math.round(metrics.totalDatabaseLockWaitMs / finished) : 0,
        concurrency: concurrencySnapshot()
    };
}

function recordFinished({ durationMs, processSlotWaitMs, databaseLockWaitMs, error }) {
    metrics.totalDurationMs += durationMs;
    metrics.totalProcessSlotWaitMs += processSlotWaitMs;
    metrics.totalDatabaseLockWaitMs += databaseLockWaitMs;
    metrics.maxDurationMs = Math.max(metrics.maxDurationMs, durationMs);
    metrics.maxProcessSlotWaitMs = Math.max(metrics.maxProcessSlotWaitMs, processSlotWaitMs);
    metrics.maxDatabaseLockWaitMs = Math.max(metrics.maxDatabaseLockWaitMs, databaseLockWaitMs);
    metrics.lastDurationMs = durationMs;
    metrics.lastProcessSlotWaitMs = processSlotWaitMs;
    metrics.lastDatabaseLockWaitMs = databaseLockWaitMs;
    metrics.lastFinishedAt = new Date().toISOString();
    metrics.lastErrorCode = error?.code || null;
    if (error) {
        metrics.failed += 1;
        if (error.code === 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT') metrics.lockTimeouts += 1;
    } else {
        metrics.succeeded += 1;
    }
}

async function tryAdvisoryLock(client, id) {
    const result = await client.query(
        'SELECT pg_try_advisory_lock($1::int,hashtext($2::text)) AS locked',
        [LOCK_NAMESPACE, id]
    );
    return result.rows[0]?.locked === true;
}

function advisoryUnlock(client, id) {
    return client.query('SELECT pg_advisory_unlock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, id]);
}

async function acquire(client, customerId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
        if (await tryAdvisoryLock(client, customerId)) return true;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return false;
}

function lockTimeoutError() {
    const error = new Error('Another reconciliation for this customer is still running. Try again shortly.');
    error.code = 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT';
    return error;
}

function reportUnlockFailure(id, error) {
    metrics.cleanupFailures += 1;
    console.error('Customer reconciliation advisory unlock failed:', { customerId: id, error: error.message });
}

// Counts the nested locks held at one nesting level and everything below it.
function createScope(parent) {
    // closing: its callback has settled and it is only waiting to be released.
    return { parent, held: 0, idle: [], closing: false };
}

function adjustHeld(scope, delta) {
    for (let current = scope; current; current = current.parent) {
        current.held += delta;
        if (!current.held) current.idle.splice(0).forEach(resolve => resolve());
    }
}

// Releasing a lock while work nested under it still runs would silently drop
// that work's exclusion, so the owner waits. Callers must re-check scope.held
// in the same synchronous step as whatever they do next.
async function waitForNested(scope, id) {
    const started = Date.now();
    const warning = setInterval(() => {
        console.warn('Customer reconciliation lock is still waiting for nested locks to finish.', {
            customerId: id,
            nestedLocks: scope.held,
            waitedMs: Date.now() - started
        });
    }, NESTED_WAIT_WARNING_MS);
    try {
        while (scope.held) await new Promise(resolve => scope.idle.push(resolve));
    } finally {
        clearInterval(warning);
    }
}

function createLockSession(client, heldKeys = []) {
    return {
        client,
        // Every key held or being attempted on this database session. PostgreSQL
        // would grant a session its own lock again, so exclusion between callers
        // sharing the session has to be enforced here.
        keys: new Set(heldKeys),
        root: createScope(null),
        open: true,
        released: false,
        // A lock or unlock query failed: take no further locks on this session.
        unsafe: false,
        tail: Promise.resolve()
    };
}

// A pg client runs one query at a time, so callers sharing a session take turns.
function onSession(session, work) {
    const result = session.tail.then(work);
    session.tail = result.then(() => undefined, () => undefined);
    return result;
}

async function drainSession(session) {
    let tail;
    do {
        tail = session.tail;
        await tail;
    } while (tail !== session.tail);
}

async function closeLockSession(session, id) {
    session.root.closing = true;
    while (session.root.held) await waitForNested(session.root, id);
    session.open = false;
}

// Resolves to 'locked', 'timeout', or 'unavailable' when the caller must use a
// database session of its own.
async function acquireOnSession(session, parentScope, id, deadline) {
    for (;;) {
        if (!session.open || session.unsafe) return 'unavailable';
        if (!session.keys.has(id)) {
            session.keys.add(id);
            let outcome = 'busy';
            try {
                outcome = await onSession(session, async () => {
                    if (!session.open || session.unsafe) return 'unavailable';
                    try {
                        if (!await tryAdvisoryLock(session.client, id)) return 'busy';
                        // A level that is only waiting to be released takes
                        // no new locks: it may already have stopped waiting.
                        if (!session.open || parentScope.closing) {
                            await advisoryUnlock(session.client, id);
                            return 'unavailable';
                        }
                    } catch (error) {
                        // The server may or may not hold the lock now.
                        session.unsafe = true;
                        throw error;
                    }
                    adjustHeld(parentScope, 1);
                    return 'locked';
                });
            } finally {
                if (outcome !== 'locked') session.keys.delete(id);
            }
            if (outcome !== 'busy') return outcome;
        }
        if (Date.now() >= deadline) return 'timeout';
        await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    }
}

async function releaseOnSession(session, parentScope, id) {
    try {
        await onSession(session, async () => {
            // A released session has been ended or discarded, taking the lock with it.
            if (session.released) return;
            await advisoryUnlock(session.client, id);
            session.keys.delete(id);
        });
    } catch (error) {
        session.unsafe = true;
        reportUnlockFailure(id, error);
    } finally {
        adjustHeld(parentScope, -1);
    }
}

async function runNested(session, parentScope, id, fn) {
    const scope = createScope(parentScope);
    try {
        return await lockSession.run({ session, scope }, async () => fn());
    } finally {
        scope.closing = true;
        while (scope.held) await waitForNested(scope, id);
        await releaseOnSession(session, parentScope, id);
    }
}

async function runOnDedicatedSession(id, fn, timeoutMs, timing) {
    const processSlotStarted = Date.now();
    let client = null;
    let locked = false;
    let session = null;

    // The PostgreSQL advisory lock remains the correctness lock across app and
    // worker processes. This process-local permit only bounds how many dedicated
    // lock connections can be held while reconciliations call external services.
    await acquireProcessSlot();
    timing.processSlotWaitMs = Date.now() - processSlotStarted;
    try {
        client = new Client(clientConfig());
        await client.connect();
        const databaseLockStarted = Date.now();
        locked = await acquire(client, id, timeoutMs);
        timing.databaseLockWaitMs += Date.now() - databaseLockStarted;
        if (!locked) throw lockTimeoutError();
        // Do not coalesce concurrent calls. The caller waiting behind this lock
        // must run after the first reconcile completes so it can observe state
        // mutations (new holds, plan changes, payment events) that happened while
        // the first reconcile was already in progress.
        session = createLockSession(client, [id]);
        return await lockSession.run({ session, scope: session.root }, async () => fn());
    } finally {
        if (session) await closeLockSession(session, id);
        if (client && locked) {
            try {
                await (session
                    ? onSession(session, () => advisoryUnlock(client, id))
                    : advisoryUnlock(client, id));
            } catch (error) {
                reportUnlockFailure(id, error);
            }
        }
        if (session) {
            await drainSession(session);
            session.released = true;
        }
        if (client) {
            try {
                await client.end();
            } catch (error) {
                metrics.cleanupFailures += 1;
                console.warn('Customer reconciliation database connection cleanup failed.', { customerId: id, error: error.message });
            }
        }
        releaseProcessSlot();
    }
}

async function withDatabaseLock(customerId, fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
    const id = cleanCustomerId(customerId);
    if (typeof fn !== 'function') throw new Error('Reconciliation lock requires a callback.');
    const boundedTimeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || LOCK_TIMEOUT_MS));
    const operationStarted = Date.now();
    const timing = { processSlotWaitMs: 0, databaseLockWaitMs: 0 };
    let failure = null;
    metrics.started += 1;

    try {
        const parent = lockSession.getStore();
        // Work detached from a level that is only waiting to be released takes
        // its own session, so it cannot keep extending that level's lifetime.
        // Callbacks still running under it keep nesting on the shared session.
        if (parent?.session.open && !parent.scope.closing) {
            const databaseLockStarted = Date.now();
            const outcome = await acquireOnSession(parent.session, parent.scope, id, databaseLockStarted + boundedTimeout);
            timing.databaseLockWaitMs = Date.now() - databaseLockStarted;
            if (outcome === 'timeout') throw lockTimeoutError();
            if (outcome === 'locked') return await runNested(parent.session, parent.scope, id, fn);
        }
        return await runOnDedicatedSession(id, fn, boundedTimeout, timing);
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        recordFinished({
            durationMs: Date.now() - operationStarted,
            processSlotWaitMs: timing.processSlotWaitMs,
            databaseLockWaitMs: timing.databaseLockWaitMs,
            error: failure
        });
    }
}

// Lets a caller that already holds an idle, dedicated database client carry the
// locks taken inside fn, without using a process slot. The client is never ended
// here. onUnsafe means it may still hold a lock or is broken, so its owner must
// destroy it rather than return it to a pool.
async function runWithLockSession(client, fn, { onUnsafe } = {}) {
    if (!client || typeof client.query !== 'function') throw new Error('Reconciliation lock session requires a database client.');
    if (typeof fn !== 'function') throw new Error('Reconciliation lock session requires a callback.');
    const session = createLockSession(client);
    try {
        return await lockSession.run({ session, scope: session.root }, async () => fn());
    } finally {
        await closeLockSession(session, null);
        await drainSession(session);
        session.released = true;
        if (session.unsafe) onUnsafe?.();
    }
}

async function withCustomerReconciliationLock(customerId, fn, options = {}) {
    return withDatabaseLock(customerId, fn, options);
}

module.exports = {
    LOCK_NAMESPACE,
    LOCK_TIMEOUT_MS,
    LOCK_POLL_MS,
    DEFAULT_MAX_CONCURRENCY,
    NESTED_WAIT_WARNING_MS,
    AUTOMATION_DEFAULT_RECONCILIATION_MAX,
    MAX_CONCURRENCY,
    cleanCustomerId,
    clientConfig,
    reconciliationConcurrencyLimit,
    acquireProcessSlot,
    releaseProcessSlot,
    concurrencySnapshot,
    metricsSnapshot,
    acquire,
    withDatabaseLock,
    runWithLockSession,
    withCustomerReconciliationLock
};
