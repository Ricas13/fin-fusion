'use strict';

const { getPool } = require('../db');

const LOCK_SEED = '904731';
function lockSql(kind='lock'){return `SELECT pg_advisory_${kind}(hashtextextended($1::text,$2::bigint))`;}
function key(resellerId){return `captainfin:reseller-capacity:${String(resellerId)}`;}

async function withCapacityLock(resellerId, fn) {
    const client = await getPool().connect();
    const value = key(resellerId);
    try {
        await client.query(lockSql('lock'), [value, LOCK_SEED]);
        return await fn();
    } finally {
        try { await client.query(lockSql('unlock'), [value, LOCK_SEED]); } catch (_) {}
        client.release();
    }
}

module.exports = { withCapacityLock, key, LOCK_SEED };
