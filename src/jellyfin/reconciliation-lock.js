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
    let client = null;
    let locked = false;

    // The PostgreSQL advisory lock remains the correctness lock across app and
    // worker processes. This process-local permit only bounds how many dedicated
    // lock connections can be held while reconciliations call external services.
    await acquireProcessSlot();
    try {
        client = new Client(clientConfig());
        await client.connect();
        locked = await acquire(client, id, boundedTimeout);
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
    } finally {
        if (client && locked) {
            try { await client.query('SELECT pg_advisory_unlock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, id]); }
            catch (error) { console.error('Customer reconciliation advisory unlock failed:', { customerId: id, error: error.message }); }
        }
        if (client) await client.end().catch(() => {});
        releaseProcessSlot();
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
    acquire,
    withDatabaseLock,
    withCustomerReconciliationLock
};
