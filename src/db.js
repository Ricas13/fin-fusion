const { Pool } = require('pg');

let pool;

function getPool() {
    if (pool) return pool;

    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required for PostgreSQL mode');
    }

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Number(process.env.DB_POOL_SIZE || 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: 10000,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
    });

    pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL pool error:', err);
    });

    return pool;
}

async function query(text, params = []) {
    return getPool().query(text, params);
}

async function transaction(fn) {
    const client = await getPool().connect();
    try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
    }
}

async function healthcheck() {
    const started = Date.now();
    const result = await query('SELECT NOW() AS now');
    return { ok: true, latencyMs: Date.now() - started, now: result.rows[0].now };
}

module.exports = { getPool, query, transaction, healthcheck };
