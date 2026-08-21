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
    await pool.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await pool.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

async function databaseShape(pool) {
    const result = await pool.query(`
        SELECT table_name
        FROM information_schema.tables
        WHERE table_schema='public'
          AND table_type='BASE TABLE'
          AND table_name <> 'schema_migrations'
    `);
    const names = new Set(result.rows.map(row => String(row.table_name)));
    const anchors = ['app_users','customers','plans','jellyfin_servers','subscriptions'];
    return {
        empty: names.size === 0,
        recognizableInstall: anchors.filter(name => names.has(name)).length >= 2,
        tables: names
    };
}

async function verifyOrBaselineAppliedMigration(pool, filename, checksum) {
    const existing = await pool.query(
        'SELECT checksum FROM public.schema_migrations WHERE filename=$1',
        [filename]
    );
    if (!existing.rowCount) return false;

    const recorded = existing.rows[0].checksum;
    if (!recorded) {
        await pool.query(
            'UPDATE public.schema_migrations SET checksum=$2 WHERE filename=$1 AND checksum IS NULL',
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

async function adoptBaseline(pool, filename, checksum) {
    await pool.query(
        'INSERT INTO public.schema_migrations(filename,checksum) VALUES($1,$2)',
        [filename, checksum]
    );
    console.log(`adopt ${filename}`);
}

async function applyMigration(pool, filename, sql, checksum, freshInstall) {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query("SELECT pg_catalog.set_config('search_path','public',false)");
        await client.query("SELECT set_config('steamfusion.fresh_install',$1,true)", [freshInstall ? 'on' : 'off']);
        await client.query(unwrapTransaction(sql));
        // pg_dump baselines intentionally set an empty search_path. Restore the
        // application schema before updating the migration ledger or continuing.
        await client.query("SELECT pg_catalog.set_config('search_path','public',false)");
        await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
            filename TEXT PRIMARY KEY,
            checksum TEXT,
            applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
        await client.query(
            'INSERT INTO public.schema_migrations(filename,checksum) VALUES($1,$2)',
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
        const shape = await databaseShape(pool);
        const freshInstall = shape.empty || !shape.recognizableInstall;
        const adoptExistingBaseline = !shape.empty && shape.recognizableInstall;
        if (shape.empty) console.log('fresh database detected: applying clean-install baseline');
        else if (adoptExistingBaseline) console.log('recognizable CAPTAiNFiN schema detected: adopting baseline before incremental migrations');
        else console.log('non-CAPTAiNFiN public tables detected: applying baseline alongside existing data');

        for (const filename of files) {
            const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
            const checksum = migrationChecksum(sql);

            if (await verifyOrBaselineAppliedMigration(pool, filename, checksum)) {
                console.log(`skip ${filename}`);
                continue;
            }

            if (filename === '000_database_baseline.sql' && adoptExistingBaseline) {
                await adoptBaseline(pool, filename, checksum);
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
