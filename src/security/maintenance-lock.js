'use strict';

const { getPool } = require('../db');
const { RESTORE_MAINTENANCE_LOCK } = require('../db-locks');

async function requestMaintenanceGuard(req, res, next) {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();

    let client = null;
    let locked = false;
    let released = false;
    const release = async () => {
        if (released) return;
        released = true;
        if (!client) return;
        try {
            if (locked) {
                await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
            }
        } catch (error) {
            console.warn(`Maintenance request-lock release failed: ${error.message}`);
        } finally {
            client.release();
            client = null;
        }
    };

    try {
        client = await getPool().connect();
        const result = await client.query(
            'SELECT pg_try_advisory_lock_shared($1::bigint) AS allowed',
            [RESTORE_MAINTENANCE_LOCK]
        );
        locked = result.rows[0]?.allowed === true;
        if (!locked) {
            res.setHeader('Retry-After', '30');
            await release();
            return res.status(503).send('CAPTaINFiN is temporarily unavailable for database maintenance.');
        }

        // Keep the shared session-level lock for the complete mutation request,
        // including any provider/API calls that occur before the local DB write.
        // An exclusive restore lock therefore cannot be acquired halfway through
        // a Stripe/PayPal/admin transition. Release on either normal completion
        // or an aborted connection; release() is idempotent for the dual events.
        res.once('finish', () => { release().catch(() => {}); });
        res.once('close', () => { release().catch(() => {}); });
        return next();
    } catch (error) {
        await release();
        return next(error);
    }
}

module.exports = { requestMaintenanceGuard };
