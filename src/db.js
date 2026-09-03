const path = require('path');
const { Pool } = require('pg');
const { RESTORE_MAINTENANCE_LOCK } = require('./db-locks');

const DEFAULT_WEB_DATABASE_ROLE = 'steamfusion_app';
let pool;

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
        connectionTimeoutMillis: 10000,
        ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : false
    });

    pool.on('error', (err) => {
        console.error('Unexpected PostgreSQL pool error:', err);
    });

    return pool;
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
    return getPool().query(text, params);
}

async function mutationQuery(text, params = []) {
    const client = await getPool().connect();
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
    const client = await getPool().connect();
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
    return { ok: true, latencyMs: Date.now() - started, now: result.rows[0].now };
}

async function closePool() {
    if (!pool) return;
    const current = pool;
    pool = undefined;
    await current.end();
}

module.exports = {
    getPool,
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
    DEFAULT_WEB_DATABASE_ROLE
};
