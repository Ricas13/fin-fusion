'use strict';

const { getPool } = require('../db');
const { RESTORE_MAINTENANCE_LOCK } = require('../db-locks');

async function acquireSharedMaintenanceLock({ tryOnly = true } = {}) {
    const client = await getPool().connect();
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
            return res.status(503).send('CAPTaINFiN is temporarily unavailable for database maintenance.');
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

module.exports = { acquireSharedMaintenanceLock, withMaintenanceSharedLock, requestMaintenanceGuard };
