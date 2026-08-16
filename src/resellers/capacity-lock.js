'use strict';

const { Pool } = require('pg');

const LOCK_SEED = '904731';
function lockSql(kind='lock'){return `SELECT pg_advisory_${kind}(hashtextextended($1::text,$2::bigint))`;}
function key(resellerId){return `captainfin:reseller-capacity:${String(resellerId)}`;}

// Capacity locks are session-level and may wrap business functions that open
// transactions from the normal application pool. Keep the guard connection in
// its own small pool so a surge of capacity mutations cannot consume every main
// DB connection while each callback waits for another one.
const lockPool=new Pool({
    connectionString:process.env.DATABASE_URL,
    max:Math.max(2,Math.min(16,Number(process.env.RESELLER_CAPACITY_LOCK_POOL_MAX||8))),
    idleTimeoutMillis:30000,
    connectionTimeoutMillis:Math.max(1000,Math.min(30000,Number(process.env.RESELLER_CAPACITY_LOCK_TIMEOUT_MS||5000))),
    allowExitOnIdle:true
});

async function withCapacityLock(resellerId, fn) {
    const client = await lockPool.connect();
    const value = key(resellerId);
    let locked=false;
    try {
        await client.query(lockSql('lock'), [value, LOCK_SEED]);
        locked=true;
        return await fn();
    } finally {
        if(locked)try { await client.query(lockSql('unlock'), [value, LOCK_SEED]); } catch (_) {}
        client.release();
    }
}

async function closeCapacityLockPool(){await lockPool.end();}
module.exports = { withCapacityLock, closeCapacityLockPool, key, LOCK_SEED };
