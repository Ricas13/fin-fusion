'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');
const { encryptWithEnv } = require('../src/security/purpose-crypto');

const dataFile = process.env.LEGACY_DATA_FILE || path.join(__dirname, '..', 'db', 'data.json');
const CONFIRM_FLAG = '--confirm-legacy-migration';
const NONEMPTY_OVERRIDE_FLAG = '--allow-nonempty-target';

function requireExplicitConfirmation() {
    if (process.argv.includes(CONFIRM_FLAG)) return;
    throw new Error(
        'Refusing to run the legacy JSON importer without explicit confirmation. ' +
        `Use: node scripts/migrate-json-to-postgres.js ${CONFIRM_FLAG}`
    );
}

async function assertTargetIsSafe(client) {
    const state = await client.query(`
        SELECT
            (SELECT COUNT(*)::int FROM customers) AS customers,
            (SELECT COUNT(*)::int FROM subscriptions) AS subscriptions,
            (SELECT COUNT(*)::int FROM jellyfin_accounts) AS jellyfin_accounts
    `);
    const counts = state.rows[0] || {};
    const occupied = Number(counts.customers || 0) + Number(counts.subscriptions || 0) + Number(counts.jellyfin_accounts || 0);
    if (!occupied) return;

    const summary = `customers=${counts.customers || 0}, subscriptions=${counts.subscriptions || 0}, jellyfin_accounts=${counts.jellyfin_accounts || 0}`;
    if (!process.argv.includes(NONEMPTY_OVERRIDE_FLAG)) {
        throw new Error(
            `Refusing legacy JSON import into a non-empty target (${summary}). ` +
            `This importer is for one-time migration only. If you have independently verified the destination and really intend to merge legacy data, add ${NONEMPTY_OVERRIDE_FLAG}.`
        );
    }

    console.warn(`WARNING: legacy JSON import is targeting a non-empty database (${summary}).`);
    console.warn('WARNING: the non-empty-target override can create duplicate customer/subscription records; use only for a deliberate recovery migration.');
}

async function main() {
    requireExplicitConfirmation();

    if (!fs.existsSync(dataFile)) {
        throw new Error(`Legacy data file not found: ${dataFile}`);
    }

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const pool = getPool();
    const client = await pool.connect();

    try {
        await assertTargetIsSafe(client);
        await client.query('BEGIN');

        const adminMap = new Map();
        for (const admin of data.admins || []) {
            const result = await client.query(`
                INSERT INTO app_users(
                    username,password_hash,role,active,legacy_numeric_id,password_changed_at,created_at
                ) VALUES($1,$2,'admin',TRUE,$3,COALESCE($4::timestamptz,NOW()),COALESCE($5::timestamptz,NOW()))
                ON CONFLICT(username) DO UPDATE SET
                    legacy_numeric_id=EXCLUDED.legacy_numeric_id,
                    active=TRUE,
                    updated_at=NOW()
                WHERE app_users.role='admin'
                RETURNING id
            `, [admin.username, admin.password, Number(admin.id), admin.passwordChangedAt || null, admin.createdAt || null]);
            if (!result.rowCount) throw new Error(`Role mismatch for existing admin ${admin.username}`);
            adminMap.set(admin.id, result.rows[0].id);
        }

        let defaultServerId = null;
        if (process.env.JELLYFIN_URL && process.env.JELLYFIN_API_KEY && process.env.JELLYFIN_ENCRYPTION_KEY) {
            const server = await client.query(`
                INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority)
                VALUES($1,$2,$3,$4,$5,$6,TRUE,10)
                ON CONFLICT(slug) DO UPDATE SET base_url=EXCLUDED.base_url,public_url=EXCLUDED.public_url,api_key_encrypted=EXCLUDED.api_key_encrypted
                RETURNING id
            `, [
                process.env.LEGACY_SERVER_NAME || 'Primary Jellyfin',
                process.env.LEGACY_SERVER_SLUG || 'primary',
                process.env.LEGACY_SERVER_CLASS || 'premium',
                process.env.JELLYFIN_URL,
                process.env.JELLYFIN_PUBLIC_URL || process.env.JELLYFIN_URL,
                encryptWithEnv(process.env.JELLYFIN_API_KEY, 'JELLYFIN_ENCRYPTION_KEY', 'jf1')
            ]);
            defaultServerId = server.rows[0].id;
        }

        for (const c of data.clients || []) {
            const customer = await client.query(`
                INSERT INTO customers(display_name,note,created_at)
                VALUES($1,$2,COALESCE($3::timestamptz,NOW()))
                RETURNING id
            `, [c.username, c.note || '', c.createdAt || null]);
            const customerId = customer.rows[0].id;

            if (defaultServerId && c.jellyfinId) {
                await client.query(`
                    INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,last_activity_at,created_at)
                    VALUES($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz,NOW()))
                    ON CONFLICT(server_id,jellyfin_user_id) DO NOTHING
                `, [customerId, defaultServerId, c.jellyfinId, c.username, !!c.disabled, c.lastWatched || null, c.createdAt || null]);
            }

            const planCode = c.isPaid ? 'monthly' : 'trial-24h';
            const plan = await client.query('SELECT id FROM plans WHERE code=$1', [planCode]);
            if (plan.rowCount) {
                const end = c.trialEnd ? new Date(c.trialEnd) : new Date();
                const start = c.trialStart ? new Date(c.trialStart) : new Date(c.createdAt || Date.now());
                const status = end > new Date() ? (c.isPaid ? 'active' : 'trialing') : 'expired';
                await client.query(`
                    INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,created_at)
                    VALUES($1,$2,$3,'migration',$4,$5,COALESCE($6::timestamptz,NOW()))
                `, [customerId, plan.rows[0].id, status, start, end, c.createdAt || null]);
            }
        }

        await client.query('COMMIT');
        console.log(`Imported ${(data.admins || []).length} admins and ${(data.clients || []).length} clients.`);
        console.log('Legacy client passwords are intentionally not imported. Reset them if they must be re-shared.');
        console.log('Existing PostgreSQL staff passwords are preserved when usernames already exist.');
    } catch (err) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
