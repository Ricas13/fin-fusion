'use strict';

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

async function acquire(client, customerId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    do {
        const result = await client.query(
            'SELECT pg_try_advisory_lock($1::int,hashtext($2::text)) AS locked',
            [LOCK_NAMESPACE, customerId]
        );
        if (result.rows[0]?.locked === true) return true;
        if (Date.now() >= deadline) break;
        await sleep(Math.min(LOCK_POLL_MS, Math.max(1, deadline - Date.now())));
    } while (Date.now() <= deadline);
    return false;
}

async function withDatabaseLock(customerId, fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
    const id = cleanCustomerId(customerId);
    if (typeof fn !== 'function') throw new Error('Reconciliation lock requires a callback.');
    const boundedTimeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || LOCK_TIMEOUT_MS));
    const operationStarted = Date.now();
    const processSlotStarted = Date.now();
    let processSlotWaitMs = 0;
    let databaseLockWaitMs = 0;
    let client = null;
    let locked = false;
    let failure = null;
    metrics.started += 1;

    // The PostgreSQL advisory lock remains the correctness lock across app and
    // worker processes. This process-local permit only bounds how many dedicated
    // lock connections can be held while reconciliations call external services.
    await acquireProcessSlot();
    processSlotWaitMs = Date.now() - processSlotStarted;
    try {
        client = new Client(clientConfig());
        await client.connect();
        const databaseLockStarted = Date.now();
        locked = await acquire(client, id, boundedTimeout);
        databaseLockWaitMs = Date.now() - databaseLockStarted;
        if (!locked) {
            const error = new Error('Another reconciliation for this customer is still running. Try again shortly.');
            error.code = 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT';
            throw error;
        }
        // Do not coalesce concurrent calls. The caller waiting behind this lock
        // must run after the first reconcile completes so it can observe state
        // mutations (new holds, plan changes, payment events) that happened while
        // the first reconcile was already in progress.
        return await fn();
    } catch (error) {
        failure = error;
        throw error;
    } finally {
        if (client && locked) {
            try {
                await client.query('SELECT pg_advisory_unlock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, id]);
            } catch (error) {
                metrics.cleanupFailures += 1;
                console.error('Customer reconciliation advisory unlock failed:', { customerId: id, error: error.message });
            }
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
        recordFinished({
            durationMs: Date.now() - operationStarted,
            processSlotWaitMs,
            databaseLockWaitMs,
            error: failure
        });
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
    withCustomerReconciliationLock
};
