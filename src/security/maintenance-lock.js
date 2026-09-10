'use strict';

const { Pool } = require('pg');
const { RESTORE_MAINTENANCE_LOCK } = require('../db-locks');
const {
    AUTOMATION_ROLE,
    boundedInteger,
    databaseRole,
    automationConnectionBudget
} = require('./database-connection-budget');

function maintenanceLockPoolMax() {
    const role = databaseRole(process.env.DATABASE_URL);
    if (role === AUTOMATION_ROLE) {
        return automationConnectionBudget().maintenanceLockPoolMax;
    }
    return boundedInteger(process.env.MAINTENANCE_LOCK_POOL_MAX, 12, 2, 32);
}

// Whole-request / whole-job advisory locks are intentionally kept off the main
// application pool. A state-changing request can need several normal DB queries
// while it holds this session-level lock; using the same finite pool for both
// can deadlock under concurrency (all clients held as guards, none left for the
// guarded work). Advisory locks are database-global, so a dedicated pool gives
// the same restore exclusion without starving normal transactions. Connection
// acquisition is bounded too: pool exhaustion must degrade like a busy restore,
// not leave a checkout or admin mutation waiting forever.
const lockPool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: maintenanceLockPoolMax(),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: Math.max(1000, Math.min(30000, Number(process.env.MAINTENANCE_LOCK_CONNECTION_TIMEOUT_MS || 5000))),
    allowExitOnIdle: true
});

async function acquireSharedMaintenanceLock({ tryOnly = true } = {}) {
    const client = await lockPool.connect();
    let locked = false;
    let released = false;
    const release = async () => {
        if (released) return;
        released = true;
        try {
            if (locked) {
                await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
            }
        } finally {
            client.release();
        }
    };

    try {
        if (tryOnly) {
            const result = await client.query(
                'SELECT pg_try_advisory_lock_shared($1::bigint) AS allowed',
                [RESTORE_MAINTENANCE_LOCK]
            );
            locked = result.rows[0]?.allowed === true;
            if (!locked) {
                await release();
                return null;
            }
        } else {
            await client.query('SELECT pg_advisory_lock_shared($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
            locked = true;
        }
        return { release };
    } catch (error) {
        await release().catch(() => {});
        throw error;
    }
}

// A session advisory lock is owned by the PostgreSQL session, not by an HTTP
// request. Holding one dedicated pool client per mutating request therefore adds
// no restore-safety compared with holding one shared session lock for all
// concurrent mutations in this Node process. Reference-counting the process lock
// preserves the whole-request restore barrier (including provider/API calls)
// while reducing the request-side lock-pool demand from O(concurrent mutations)
// to one connection per web process.
let requestLockHandle = null;
let requestLockRefs = 0;
let requestLockTransition = Promise.resolve();

function serializeRequestLock(fn) {
    const next = requestLockTransition.then(fn, fn);
    requestLockTransition = next.then(() => undefined, () => undefined);
    return next;
}

async function acquireRequestMaintenanceLock() {
    return serializeRequestLock(async () => {
        if (!requestLockHandle) {
            const handle = await acquireSharedMaintenanceLock({ tryOnly: true });
            if (!handle) return null;
            requestLockHandle = handle;
        }

        requestLockRefs += 1;
        let released = false;
        return {
            release: async () => {
                if (released) return;
                released = true;
                await serializeRequestLock(async () => {
                    requestLockRefs = Math.max(0, requestLockRefs - 1);
                    if (requestLockRefs !== 0 || !requestLockHandle) return;
                    const handle = requestLockHandle;
                    requestLockHandle = null;
                    await handle.release();
                });
            }
        };
    });
}

async function withMaintenanceSharedLock(fn, { skipIfBusy = true } = {}) {
    const handle = await acquireSharedMaintenanceLock({ tryOnly: skipIfBusy });
    if (!handle) return { skipped: true, reason: 'database_maintenance' };
    try {
        return await fn();
    } finally {
        await handle.release();
    }
}

async function requestMaintenanceGuard(req, res, next) {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();

    let handle;
    try {
        handle = await acquireRequestMaintenanceLock();
        if (!handle) {
            res.setHeader('Retry-After', '30');
            return res.status(503).send('CAPTAiNFiN is temporarily unavailable for database maintenance.');
        }

        let released = false;
        const release = async () => {
            if (released) return;
            released = true;
            await handle.release();
        };

        // Keep the process shared session-level lock for the complete mutation
        // request, including provider/API calls that occur before the local DB
        // write. The final in-flight mutation releases it; finish/close can both
        // fire, so each request lease and the underlying process lease are
        // idempotent.
        res.once('finish', () => { release().catch(error => console.warn(`Maintenance request-lock release failed: ${error.message}`)); });
        res.once('close', () => { release().catch(error => console.warn(`Maintenance request-lock release failed: ${error.message}`)); });
        return next();
    } catch (error) {
        if (handle) await handle.release().catch(() => {});
        return next(error);
    }
}

async function closeMaintenanceLockPool() {
    await serializeRequestLock(async () => {
        requestLockRefs = 0;
        if (requestLockHandle) {
            const handle = requestLockHandle;
            requestLockHandle = null;
            await handle.release().catch(() => {});
        }
    });
    await lockPool.end();
}

module.exports = {
    acquireSharedMaintenanceLock,
    acquireRequestMaintenanceLock,
    withMaintenanceSharedLock,
    requestMaintenanceGuard,
    closeMaintenanceLockPool,
    maintenanceLockPoolMax
};
