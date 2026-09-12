const path = require('path');
const { Pool } = require('pg');
const { RESTORE_MAINTENANCE_LOCK } = require('./db-locks');

const DEFAULT_WEB_DATABASE_ROLE = 'steamfusion_app';
const POOL_PRESSURE_LOG_INTERVAL_MS = 5000;
let pool;
let lastPoolPressureLogAt = 0;

function databaseUsername(databaseUrl) {
    const raw = String(databaseUrl || '').trim();
    if (!raw) return '';
    let url;
    try { url = new URL(raw); }
    catch (_) { throw new Error('DATABASE_URL must be a valid PostgreSQL URL'); }
    if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('DATABASE_URL must use postgres:// or postgresql://');
    return decodeURIComponent(url.username || '');
}

function assertWebDatabaseRole({
    nodeEnv = process.env.NODE_ENV,
    databaseUrl = process.env.DATABASE_URL,
    expectedRole = process.env.WEB_DATABASE_ROLE || DEFAULT_WEB_DATABASE_ROLE
} = {}) {
    if (String(nodeEnv || '').toLowerCase() !== 'production') return null;
    const expected = String(expectedRole || '').trim();
    if (!expected) throw new Error('WEB_DATABASE_ROLE must name the restricted PostgreSQL role used by the web runtime');
    const actual = databaseUsername(databaseUrl);
    if (!actual) throw new Error('DATABASE_URL is required for the production web runtime');
    if (actual !== expected) {
        throw new Error(`Production web DATABASE_URL must authenticate as the restricted ${expected} role (received ${actual}). Run migrations/recovery with the owner URL, but never node src/application.js.`);
    }
    return actual;
}

function directWebRuntime(argv = process.argv) {
    const entry = String(argv?.[1] || '').trim();
    if (!entry) return false;
    return path.resolve(entry) === path.resolve(__dirname, 'application.js');
}

function boundedTimeout(value, fallback, { min = 250, max = 120000 } = {}) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return Math.max(min, Math.min(max, Math.floor(parsed)));
}

function connectionTimeoutMs(value = process.env.DB_CONNECTION_TIMEOUT_MS) {
    return boundedTimeout(value, 10000, { min: 500, max: 30000 });
}

function queryTimeoutMs(value = process.env.DB_QUERY_TIMEOUT_MS) {
    return boundedTimeout(value, 30000, { min: 1000, max: 120000 });
}

function sslConfig() {
    return process.env.DB_SSL === 'true'
        ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' }
        : false;
}

// This runs before Express/session-store startup for the supported direct web
// entrypoint. It prevents a manual production launch from accidentally using
// the owner/deploy DATABASE_URL instead of the least-privilege app role.
if (directWebRuntime()) assertWebDatabaseRole();

function getPool() {
    if (pool) return pool;

    if (!process.env.DATABASE_URL) {
        throw new Error('DATABASE_URL is required for PostgreSQL mode');
    }

    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        max: Number(process.env.DB_POOL_SIZE || 10),
        idleTimeoutMillis: 30000,
        connectionTimeoutMillis: connectionTimeoutMs(),
        query_timeout: queryTimeoutMs(),
        ssl: sslConfig()
    });

    pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL pool error:', err);
    });

    return pool;
}

function poolStats(target = pool) {
    if (!target) {
        return {
            max: Number(process.env.DB_POOL_SIZE || 10),
            total: 0,
            idle: 0,
            waiting: 0,
            saturated: false
        };
    }
    const max = Number(target.options?.max || process.env.DB_POOL_SIZE || 10);
    const total = Number(target.totalCount || 0);
    const idle = Number(target.idleCount || 0);
    const waiting = Number(target.waitingCount || 0);
    return {
        max,
        total,
        idle,
        waiting,
        saturated: waiting > 0 || (total >= max && idle === 0)
    };
}

function connectionAcquisitionTimedOut(error) {
    return String(error?.message || error || '').toLowerCase().includes('timeout exceeded when trying to connect');
}

function logPoolPressure(error, context) {
    if (!connectionAcquisitionTimedOut(error)) return;
    const now = Date.now();
    if (now - lastPoolPressureLogAt < POOL_PRESSURE_LOG_INTERVAL_MS) return;
    lastPoolPressureLogAt = now;
    console.error('PostgreSQL pool pressure:', {
        context,
        error: String(error?.message || error),
        ...poolStats(getPool())
    });
}

async function acquireClient(context) {
    try {
        return await getPool().connect();
    } catch (error) {
        logPoolPressure(error, context);
        throw error;
    }
}

function isMutationSql(text) {
    const sql = String(text || '').replace(/^\s*(?:--[^\n]*\n|\/\*[\s\S]*?\*\/\s*)*/g, '').trim();
    if (/^(INSERT|UPDATE|DELETE|MERGE|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|COMMENT|REFRESH|REINDEX|CLUSTER|CALL|DO)\b/i.test(sql)) return true;
    return /^WITH\b/i.test(sql) && /\b(INSERT|UPDATE|DELETE|MERGE)\b/i.test(sql);
}

async function readQuery(text, params = []) {
    if (isMutationSql(text)) {
        throw new Error('readQuery cannot execute SQL classified as a mutation; use mutationQuery or transaction.');
    }
    try {
        return await getPool().query(text, params);
    } catch (error) {
        logPoolPressure(error, 'readQuery');
        throw error;
    }
}

async function mutationQuery(text, params = []) {
    const client = await acquireClient('mutationQuery');
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
        const result = await client.query(text, params);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

async function query(text, params = []) {
    return isMutationSql(text) ? mutationQuery(text, params) : readQuery(text, params);
}

async function transaction(fn) {
    const client = await acquireClient('transaction');
    try {
        await client.query('BEGIN');
        await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

async function healthcheck() {
    const started = Date.now();
    const result = await readQuery('SELECT NOW() AS now');
    return { ok: true, latencyMs: Date.now() - started, now: result.rows[0].now, pool: poolStats() };
}

async function closePool() {
    if (!pool) return;
    const current = pool;
    pool = undefined;
    await current.end();
}

module.exports = {
    getPool,
    poolStats,
    connectionAcquisitionTimedOut,
    query,
    readQuery,
    mutationQuery,
    transaction,
    healthcheck,
    closePool,
    isMutationSql,
    databaseUsername,
    assertWebDatabaseRole,
    directWebRuntime,
    boundedTimeout,
    connectionTimeoutMs,
    queryTimeoutMs,
    DEFAULT_WEB_DATABASE_ROLE
};
