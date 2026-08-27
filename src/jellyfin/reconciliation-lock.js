'use strict';

const { Client } = require('pg');

const LOCK_NAMESPACE = 761932;
const LOCK_TIMEOUT_MS = 30000;
const inFlight = new Map();

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

async function withDatabaseLock(customerId, fn, { timeoutMs = LOCK_TIMEOUT_MS } = {}) {
    const id = cleanCustomerId(customerId);
    const client = new Client(clientConfig());
    let locked = false;
    await client.connect();
    try {
        const boundedTimeout = Math.max(1000, Math.min(120000, Number(timeoutMs) || LOCK_TIMEOUT_MS));
        await client.query("SELECT set_config('lock_timeout',$1,false)", [`${boundedTimeout}ms`]);
        await client.query('SELECT pg_advisory_lock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, id]);
        locked = true;
        return await fn();
    } catch (error) {
        if (error?.code === '55P03') {
            const timeout = new Error('Another reconciliation for this customer is still running. Try again shortly.');
            timeout.code = 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT';
            timeout.cause = error;
            throw timeout;
        }
        throw error;
    } finally {
        if (locked) {
            try { await client.query('SELECT pg_advisory_unlock($1::int,hashtext($2::text))', [LOCK_NAMESPACE, id]); }
            catch (error) { console.error('Customer reconciliation advisory unlock failed:', { customerId: id, error: error.message }); }
        }
        await client.end().catch(() => {});
    }
}

async function withCustomerReconciliationLock(customerId, fn, options = {}) {
    const id = cleanCustomerId(customerId);
    if (typeof fn !== 'function') throw new Error('Reconciliation lock requires a callback.');
    const existing = inFlight.get(id);
    if (existing) return existing;

    const work = withDatabaseLock(id, fn, options);
    inFlight.set(id, work);
    try {
        return await work;
    } finally {
        if (inFlight.get(id) === work) inFlight.delete(id);
    }
}

module.exports = {
    LOCK_NAMESPACE,
    LOCK_TIMEOUT_MS,
    cleanCustomerId,
    withDatabaseLock,
    withCustomerReconciliationLock
};
