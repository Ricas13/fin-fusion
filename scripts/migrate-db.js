'use strict';

require('dotenv').config();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');

const LEGACY_BRIDGE_COMMIT = 'b39ca004b4bd24ebc6dbdf4546d2bb6b4111b95b';
const BASELINE_ANCHORS = ['app_users','customers','plans','jellyfin_servers','subscriptions'];
// These objects were all present immediately before the 2026-08-18 schema
// squash and are folded into 000_database_baseline.sql. An installation that
// has only the older anchor tables is not safe to mark as having adopted that
// baseline: later incremental migrations assume all of these objects exist.
const BASELINE_SENTINELS = [
    'customer_access_holds',
    'payment_incidents',
    'pending_registrations',
    'stremio_source_media_index',
    'free_access_registration_reservations'
];

function migrationChecksum(sql) {
    return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

function unwrapTransaction(sql) {
    const begin = sql.match(/^\s*BEGIN\s*;\s*/i);
    const commit = sql.match(/\s*COMMIT\s*;\s*$/i);
    if (!begin || !commit) return sql;
    return sql.slice(begin[0].length, sql.length - commit[0].length);
}

function parseArguments(argv = process.argv.slice(2)) {
    let acceptDrift = null;
    let confirmed = false;
    for (let i = 0; i < argv.length; i += 1) {
        const arg = argv[i];
        if (arg === '--accept-drift') {
            acceptDrift = String(argv[++i] || '').trim();
            continue;
        }
        if (arg === '--confirm-accept-drift') {
            confirmed = true;
            continue;
        }
        throw new Error(`Unknown migration argument: ${arg}`);
    }
    if (acceptDrift) {
        if (path.basename(acceptDrift) !== acceptDrift || !/^[A-Za-z0-9_.-]+\.sql$/.test(acceptDrift)) {
            throw new Error('--accept-drift must name one migration filename, not a path.');
        }
        if (!confirmed) {
            throw new Error('--accept-drift requires --confirm-accept-drift. Review the migration diff before accepting a new checksum.');
        }
    } else if (confirmed) {
        throw new Error('--confirm-accept-drift requires --accept-drift <filename>.');
    }
    return { acceptDrift };
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
    const recognizableInstall = BASELINE_ANCHORS.filter(name => names.has(name)).length >= 2;
    const baselineCompatible = BASELINE_SENTINELS.every(name => names.has(name));
    return {
        empty: names.size === 0,
        recognizableInstall,
        baselineCompatible,
        legacyPreBaseline: recognizableInstall && !baselineCompatible,
        missingBaselineSentinels: BASELINE_SENTINELS.filter(name => !names.has(name)),
        tables: names
    };
}

async function recordDriftAcceptance(db, { filename, oldChecksum, newChecksum }) {
    // Ledger mutation and audit evidence are one PostgreSQL statement. If the
    // audit table/constraint/write fails, the checksum update cannot commit on
    // its own. Recovery therefore remains explicit, targeted and provably
    // audited instead of merely printing a best-effort warning afterwards.
    const result = await db.query(
        `WITH repaired AS (
            UPDATE public.schema_migrations
            SET checksum=$2
            WHERE filename=$1 AND checksum=$3
            RETURNING filename
         )
         INSERT INTO public.audit_log(action,entity_type,entity_id,metadata)
         SELECT 'migration.checksum_drift_accepted','migration',filename,$4::jsonb
         FROM repaired
         RETURNING entity_id`,
        [
            filename,
            newChecksum,
            oldChecksum,
            JSON.stringify({ filename, oldChecksum, newChecksum, explicitOperatorConfirmation: true })
        ]
    );
    if (result.rowCount !== 1) {
        throw new Error(`Checksum drift recovery for ${filename} did not update exactly one reviewed migration; the ledger may have changed concurrently.`);
    }
    console.warn(`accepted migration checksum drift ${filename}: ${oldChecksum} -> ${newChecksum}`);
}

async function verifyOrBaselineAppliedMigration(pool, filename, checksum, options = {}) {
    const existing = await pool.query(
        'SELECT checksum FROM public.schema_migrations WHERE filename=$1',
        [filename]
    );
    if (!existing.rowCount) return { applied: false, repairedDrift: false };

    const recorded = existing.rows[0].checksum;
    if (!recorded) {
        await pool.query(
            'UPDATE public.schema_migrations SET checksum=$2 WHERE filename=$1 AND checksum IS NULL',
            [filename, checksum]
        );
        console.warn(`baseline checksum ${filename}`);
        return { applied: true, repairedDrift: false };
    }

    if (recorded !== checksum) {
        if (options.acceptDrift === filename) {
            await recordDriftAcceptance(pool, { filename, oldChecksum: recorded, newChecksum: checksum });
            return { applied: true, repairedDrift: true };
        }
        throw new Error(
            `Migration drift detected for ${filename}. ` +
            'An already-applied migration file was modified; create a new migration instead. ' +
            `If an operator has independently reviewed this exact drift, run: node scripts/migrate-db.js --accept-drift ${filename} --confirm-accept-drift`
        );
    }

    return { applied: true, repairedDrift: false };
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

async function runMigrations({ argv = process.argv.slice(2), pool = getPool(), closePool = true } = {}) {
    const options = parseArguments(argv);
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    let repairedDrift = false;

    try {
        // Inspect before creating/updating the current migration ledger. A
        // pre-squash installation must stop without being falsely marked as
        // baseline-compatible or partially applying the modern chain.
        const shape = await databaseShape(pool);
        if (shape.legacyPreBaseline) {
            throw new Error(
                'This CAPTAiNFiN database predates the 2026-08-18 migration baseline squash and cannot be safely direct-upgraded. ' +
                `Missing baseline objects: ${shape.missingBaselineSentinels.join(', ')}. ` +
                `First run the migrations from compatibility commit ${LEGACY_BRIDGE_COMMIT}, then upgrade to the current release.`
            );
        }

        await ensureMigrationLedger(pool);
        const freshInstall = shape.empty || !shape.recognizableInstall;
        const adoptExistingBaseline = !shape.empty && shape.recognizableInstall && shape.baselineCompatible;
        if (shape.empty) console.log('fresh database detected: applying clean-install baseline');
        else if (adoptExistingBaseline) console.log('baseline-compatible CAPTAiNFiN schema detected: adopting baseline before incremental migrations');
        else console.log('non-CAPTAiNFiN public tables detected: applying baseline alongside existing data');

        if (options.acceptDrift && !files.includes(options.acceptDrift)) {
            throw new Error(`Unknown migration supplied to --accept-drift: ${options.acceptDrift}`);
        }

        for (const filename of files) {
            const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
            const checksum = migrationChecksum(sql);
            const verification = await verifyOrBaselineAppliedMigration(pool, filename, checksum, options);
            repairedDrift = repairedDrift || verification.repairedDrift;
            if (verification.applied) {
                console.log(`skip ${filename}`);
                continue;
            }

            if (filename === '000_database_baseline.sql' && adoptExistingBaseline) {
                await adoptBaseline(pool, filename, checksum);
                continue;
            }

            await applyMigration(pool, filename, sql, checksum, freshInstall);
        }

        if (options.acceptDrift && !repairedDrift) {
            throw new Error(`No checksum drift was found for ${options.acceptDrift}; no recovery change was made.`);
        }
    } finally {
        if (closePool) await pool.end();
    }
}

if (require.main === module) {
    runMigrations().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = {
    LEGACY_BRIDGE_COMMIT,
    BASELINE_ANCHORS,
    BASELINE_SENTINELS,
    migrationChecksum,
    parseArguments,
    databaseShape,
    verifyOrBaselineAppliedMigration,
    runMigrations
};
