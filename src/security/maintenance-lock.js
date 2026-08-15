'use strict';

const { getPool } = require('../db');
const { RESTORE_MAINTENANCE_LOCK } = require('../db-locks');

async function releaseShared(client) {
    try {
        await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
    } catch (_) {
        // Releasing the checked-out connection also drops any session locks.
    } finally {
        client.release();
    }
}

async function requestMaintenanceGuard(req, res, next) {
    // Health probes are intentionally left available during maintenance and are
    // mounted before this middleware. Every other request holds a shared lock for
    // its full lifetime, preventing restore from starting mid-request and keeping
    // session-store writes out of a database replacement window.
    let client;
    try {
        client = await getPool().connect();
        const result = await client.query(
            'SELECT pg_try_advisory_lock_shared($1::bigint) AS allowed',
            [RESTORE_MAINTENANCE_LOCK]
        );
        if (result.rows[0]?.allowed !== true) {
            client.release();
            res.setHeader('Retry-After', '30');
            return res.status(503).send('CAPTaINFiN is temporarily unavailable for database maintenance.');
        }

        let released = false;
        const release = () => {
            if (released) return;
            released = true;
            releaseShared(client).catch(error => console.warn('Maintenance request lock release failed:', error.message));
        };
        res.once('finish', release);
        res.once('close', release);
        return next();
    } catch (error) {
        if (client) client.release();
        return next(error);
    }
}

module.exports = { requestMaintenanceGuard };
