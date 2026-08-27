'use strict';

const { Client } = require('pg');

const LOCK_NAMESPACE = 761932;
const LOCK_TIMEOUT_MS = 30000;
const LOCK_POLL_MS = 100;

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
    const client = new Client(clientConfig());
    const boundedTimeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || LOCK_TIMEOUT_MS));
    let locked = false;
    await client.connect();
    try {
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
        if (locked) {
            try { await client.query('SELECT pg_advisory_unlock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, id]); }
            catch (error) { console.error('Customer reconciliation advisory unlock failed:', { customerId: id, error: error.message }); }
        }
        await client.end().catch(() => {});
    }
}

async function withCustomerReconciliationLock(customerId, fn, options = {}) {
    return withDatabaseLock(customerId, fn, options);
}

module.exports = {
    LOCK_NAMESPACE,
    LOCK_TIMEOUT_MS,
    LOCK_POLL_MS,
    cleanCustomerId,
    clientConfig,
    acquire,
    withDatabaseLock,
    withCustomerReconciliationLock
};
