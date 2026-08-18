'use strict';

require('dotenv').config();

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');
const baselineMigration = '000_database_baseline.sql';
const legacyCutoverMigration = '047_lifecycle_integrity_and_operations.sql';

function unwrapTransaction(sql) {
    const begin = sql.match(/^\s*BEGIN\s*;\s*/i);
    const commit = sql.match(/\s*COMMIT\s*;\s*$/i);
    if (!begin || !commit) return sql;
    return sql.slice(begin[0].length, sql.length - commit[0].length);
}

function checksum(sql) {
    return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

async function ensureLedger(client) {
    await client.query(`CREATE TABLE IF NOT EXISTS public.schema_migrations (
        filename TEXT PRIMARY KEY,
        checksum TEXT,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
    await client.query('ALTER TABLE public.schema_migrations ADD COLUMN IF NOT EXISTS checksum TEXT');
}

async function applyMigration(client, file, fresh) {
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
    await client.query('BEGIN');
    try {
        await client.query("SELECT pg_catalog.set_config('search_path','public',false)");
        await client.query("SELECT set_config('steamfusion.fresh_install',$1,true)", [fresh ? 'on' : 'off']);
        await client.query(unwrapTransaction(sql));
        await client.query("SELECT pg_catalog.set_config('search_path','public',false)");
        await ensureLedger(client);
        await client.query(
            'INSERT INTO public.schema_migrations(filename,checksum) VALUES($1,$2)',
            [file, checksum(sql)]
        );
        await client.query('COMMIT');
    } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`${file}: ${error.message}`);
    }
}

function splitMigrations(files) {
    if (files.includes(legacyCutoverMigration)) {
        return {
            foldedBaseline: false,
            old: files.filter(file => file < legacyCutoverMigration),
            next: files.filter(file => file >= legacyCutoverMigration)
        };
    }

    assert(files.includes(baselineMigration), 'folded upgrade smoke requires the schema baseline migration');
    return {
        foldedBaseline: true,
        old: [baselineMigration],
        next: files.filter(file => file !== baselineMigration)
    };
}

async function main() {
    if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');

    const source = new URL(process.env.DATABASE_URL);
    const dbName = `steamfusion_upgrade_${crypto.randomBytes(5).toString('hex')}`;
    const adminUrl = new URL(source.toString());
    adminUrl.pathname = '/postgres';
    const dbUrl = new URL(source.toString());
    dbUrl.pathname = `/${dbName}`;

    const admin = new Client({ connectionString: adminUrl.toString() });
    let db = null;
    await admin.connect();

    try {
        await admin.query(`CREATE DATABASE ${dbName}`);
        db = new Client({ connectionString: dbUrl.toString() });
        await db.connect();
        await ensureLedger(db);

        const files = fs.readdirSync(migrationsDir).filter(file => file.endsWith('.sql')).sort();
        const plan = splitMigrations(files);

        for (const file of plan.old) await applyMigration(db, file, true);

        const suffix = crypto.randomBytes(4).toString('hex');
        const insertedPlan = (await db.query(
            `INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,active,visible,server_class,streams)
             VALUES($1,$2,'direct','year',365,5000,'GBP',TRUE,TRUE,'premium',3)
             RETURNING id,name,price_minor,currency,billing_interval,duration_days`,
            [`upgrade-${suffix}`, `Upgrade Contract ${suffix}`]
        )).rows[0];
        const customer = (await db.query(
            `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
            [`Upgrade Customer ${suffix}`, `upgrade-${suffix}@example.invalid`]
        )).rows[0];
        const subscription = (await db.query(
            `INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id)
             VALUES($1,$2,'active','stripe',NOW()-INTERVAL '3 days',NOW()+INTERVAL '362 days',$3)
             RETURNING id`,
            [customer.id, insertedPlan.id, `sub_upgrade_${suffix}`]
        )).rows[0];

        const before = (await db.query(
            `SELECT COUNT(*)::int plans,
                    (SELECT COUNT(*)::int FROM customers) customers,
                    (SELECT COUNT(*)::int FROM subscriptions) subscriptions
             FROM plans`
        )).rows[0];

        for (const file of plan.next) await applyMigration(db, file, false);

        const after = (await db.query(
            `SELECT COUNT(*)::int plans,
                    (SELECT COUNT(*)::int FROM customers) customers,
                    (SELECT COUNT(*)::int FROM subscriptions) subscriptions
             FROM plans`
        )).rows[0];

        assert.strictEqual(Number(after.customers), Number(before.customers), 'upgrade migrations must preserve customer row counts');
        assert.strictEqual(Number(after.subscriptions), Number(before.subscriptions), 'upgrade migrations must preserve subscription row counts');
        if (plan.foldedBaseline) {
            assert.strictEqual(Number(after.plans), Number(before.plans), 'folded baseline cleanup must preserve existing plan row counts');
        } else {
            assert.strictEqual(Number(after.plans), Number(before.plans) + 1, 'upgrade must add exactly the canonical free tier without losing existing plans');
        }

        const free = (await db.query(`SELECT code,active,visible,price_minor FROM plans WHERE is_free_tier=TRUE`)).rows;
        assert.strictEqual(free.length, 1, 'upgrade must have exactly one canonical free tier');
        assert.strictEqual(free[0].active, true);
        assert.strictEqual(free[0].visible, true);
        assert.strictEqual(Number(free[0].price_minor), 0);

        const upgraded = (await db.query(
            `SELECT plan_name_snapshot,price_minor_snapshot,currency_snapshot,billing_interval_snapshot,duration_days_snapshot
             FROM subscriptions WHERE id=$1`,
            [subscription.id]
        )).rows[0];
        assert.strictEqual(upgraded.plan_name_snapshot, insertedPlan.name);
        assert.strictEqual(Number(upgraded.price_minor_snapshot), Number(insertedPlan.price_minor));
        assert.strictEqual(String(upgraded.currency_snapshot).trim(), String(insertedPlan.currency).trim());
        assert.strictEqual(upgraded.billing_interval_snapshot, insertedPlan.billing_interval);
        assert.strictEqual(Number(upgraded.duration_days_snapshot), Number(insertedPlan.duration_days));

        const columns = await db.query(`
            SELECT to_regclass('public.operational_worker_state') workers,
                   to_regclass('public.notification_outbox') notifications,
                   (SELECT COUNT(*) FROM information_schema.columns WHERE table_name='customer_plan_changes' AND column_name='provider_schedule_id') schedule_column
        `);
        assert(
            columns.rows[0].workers && columns.rows[0].notifications && Number(columns.rows[0].schedule_column) === 1,
            'new lifecycle schema must exist after upgrade'
        );

        console.log(`upgrade path ${plan.old.at(-1)} -> ${plan.next.at(-1) || plan.old.at(-1)} preserves contracts`);
    } finally {
        if (db) await db.end().catch(() => {});
        await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => {});
        await admin.end();
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
