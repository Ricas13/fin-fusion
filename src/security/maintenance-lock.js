'use strict';

const { Pool } = require('pg');
const { RESTORE_MAINTENANCE_LOCK } = require('../db-locks');

const AUTOMATION_ROLE = 'steamfusion_automation';
const AUTOMATION_ROLE_CONNECTION_LIMIT = 12;
const AUTOMATION_DEFAULT_LOCK_POOL_MAX = 4;
// The automation container healthcheck opens its own pg.Client. Keep one more
// connection free for transient/control work so the role never runs exactly at
// its PostgreSQL CONNECTION LIMIT during a normal worker cycle.
const AUTOMATION_NON_POOL_RESERVE = 2;

function boundedInt(value, fallback, min, max) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, Math.trunc(parsed)));
}

function databaseRole(connectionString) {
    try {
        return decodeURIComponent(new URL(String(connectionString || '')).username || '');
    } catch (_) {
        return '';
    }
}

function maintenanceLockPoolMax() {
    const role = databaseRole(process.env.DATABASE_URL);
    const explicit = String(process.env.MAINTENANCE_LOCK_POOL_MAX || '').trim();
    const requested = boundedInt(
        explicit || (role === AUTOMATION_ROLE ? AUTOMATION_DEFAULT_LOCK_POOL_MAX : 12),
        role === AUTOMATION_ROLE ? AUTOMATION_DEFAULT_LOCK_POOL_MAX : 12,
        2,
        32
    );

    if (role !== AUTOMATION_ROLE) return requested;

    // The automation role is deliberately connection-limited. Its normal pg
    // pool, this independent advisory-lock pool, and the Docker healthcheck all
    // authenticate as the same role. Previously the lock pool defaulted to 12
    // by itself while the role limit was also 12, so real automation load could
    // exhaust the role and make unrelated jobs fail together.
    const primaryPoolMax = boundedInt(process.env.DB_POOL_SIZE, 6, 1, 50);
    const availableForLocks = AUTOMATION_ROLE_CONNECTION_LIMIT - primaryPoolMax - AUTOMATION_NON_POOL_RESERVE;
    if (availableForLocks < 2) {
        throw new Error(
            `Unsafe automation database pool budget: DB_POOL_SIZE=${primaryPoolMax} leaves fewer than 2 maintenance-lock connections under the ${AUTOMATION_ROLE_CONNECTION_LIMIT}-connection role limit.`
        );
    }
    if (requested > availableForLocks) {
        if (explicit) {
            throw new Error(
                `Unsafe automation maintenance-lock pool: MAINTENANCE_LOCK_POOL_MAX=${requested} with DB_POOL_SIZE=${primaryPoolMax} exceeds the ${AUTOMATION_ROLE_CONNECTION_LIMIT}-connection role budget.`
            );
        }
        return availableForLocks;
    }
    return requested;
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
        handle = await acquireSharedMaintenanceLock({ tryOnly: true });
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

        // Keep the shared session-level lock for the complete mutation request,
        // including any provider/API calls that occur before the local DB write.
        // An exclusive restore lock therefore cannot be acquired halfway through
        // a Stripe/PayPal/admin transition. Release on either normal completion
        // or an aborted connection; release() is idempotent for the dual events.
        res.once('finish', () => { release().catch(error => console.warn(`Maintenance request-lock release failed: ${error.message}`)); });
        res.once('close', () => { release().catch(error => console.warn(`Maintenance request-lock release failed: ${error.message}`)); });
        return next();
    } catch (error) {
        if (handle) await handle.release().catch(() => {});
        return next(error);
    }
}

async function closeMaintenanceLockPool() {
    await lockPool.end();
}

module.exports = { acquireSharedMaintenanceLock, withMaintenanceSharedLock, requestMaintenanceGuard, closeMaintenanceLockPool };
