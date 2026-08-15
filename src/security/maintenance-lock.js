'use strict';

const { getPool } = require('../db');
const { RESTORE_MAINTENANCE_LOCK } = require('../db-locks');

async function requestMaintenanceGuard(req, res, next) {
    if (['GET','HEAD','OPTIONS'].includes(req.method)) return next();
    let client;
    try {
        client = await getPool().connect();
        const result = await client.query(
            'SELECT pg_try_advisory_lock_shared($1::bigint) AS allowed',
            [RESTORE_MAINTENANCE_LOCK]
        );
        if (result.rows[0]?.allowed !== true) {
            res.setHeader('Retry-After', '30');
            return res.status(503).send('CAPTaINFiN is temporarily unavailable for database maintenance.');
        }
        await client.query('SELECT pg_advisory_unlock_shared($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
        return next();
    } catch (error) {
        return next(error);
    } finally {
        if (client) client.release();
    }
}

module.exports = { requestMaintenanceGuard };
