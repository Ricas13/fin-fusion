'use strict';

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');

function migrationChecksum(sql) {
    return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

function unwrapTransaction(sql) {
    const begin = sql.match(/^\s*BEGIN\s*;\s*/i);
    const commit = sql.match(/\s*COMMIT\s*;\s*$/i);
    if (!begin || !commit) return sql;
    return sql.slice(begin[0].length, sql.length - commit[0].length);
}

async function ensureMigrationLedger(pool) {
    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('ALTER TABLE schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

async function detectFreshDatabase(pool) {
    // Detect freshness from schema shape rather than migration-ledger count alone.
    // Older deployments may have application tables but no historical ledger;
    // those must NEVER receive fresh-install cleanup/defaults.
    const result = await pool.query(`
        SELECT COUNT(*)::int AS count
        FROM information_schema.tables
        WHERE table_schema='public'
          AND table_type='BASE TABLE'
          AND table_name <> 'schema_migrations'
    `);
    return Number(result.rows[0]?.count || 0) === 0;
}

async function verifyOrBaselineAppliedMigration(pool, filename, checksum) {
    const existing = await pool.query(
        'SELECT checksum FROM schema_migrations WHERE filename=$1',
        [filename]
    );
    if (!existing.rowCount) return false;

    const recorded = existing.rows[0].checksum;
    if (!recorded) {
        // Older installations predate checksum tracking. Baseline the exact file
        // currently deployed so all subsequent edits are detected deterministically.
        await pool.query(
            'UPDATE schema_migrations SET checksum=$2 WHERE filename=$1 AND checksum IS NULL',
            [filename, checksum]
        );
        console.warn(`baseline checksum ${filename}`);
        return true;
    }

    if (recorded !== checksum) {
        throw new Error(
            `Migration drift detected for ${filename}. ` +
            'An already-applied migration file was modified; create a new migration instead.'
        );
    }

    return true;
}

async function applyMigration(pool, filename, sql, checksum, freshInstall) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        // Expose a transaction-local marker to migrations that need to distinguish
        // a truly blank database from an upgrade. Existing deployments always see
        // "off"; this prevents cleanup/default migrations from rewriting live data.
        await client.query("SELECT set_config('steamfusion.fresh_install',$1,true)", [freshInstall ? 'on' : 'off']);
        // Historical migrations include their own BEGIN/COMMIT wrappers. Strip only
        // those outer wrappers so the schema change and ledger insert commit atomically.
        await client.query(unwrapTransaction(sql));
        await client.query(
            'INSERT INTO schema_migrations(filename,checksum) VALUES($1,$2)',
            [filename, checksum]
        );
        await client.query('COMMIT');
        console.log(`applied ${filename}`);
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
    }
}

async function main() {
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const pool = getPool();

    try {
        await ensureMigrationLedger(pool);
        const freshInstall = await detectFreshDatabase(pool);
        if (freshInstall) console.log('fresh database detected: applying clean-install defaults');

        for (const filename of files) {
            const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
            const checksum = migrationChecksum(sql);

            if (await verifyOrBaselineAppliedMigration(pool, filename, checksum)) {
                console.log(`skip ${filename}`);
                continue;
            }

            await applyMigration(pool, filename, sql, checksum, freshInstall);
        }
    } finally {
        await pool.end();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
