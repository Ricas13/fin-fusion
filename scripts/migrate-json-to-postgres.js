require('dotenv').config();
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const { getPool } = require('../src/db');
const { encryptString } = require('../src/crypto');

const dataFile = process.env.LEGACY_DATA_FILE || path.join(__dirname, '..', 'db', 'data.json');

async function main() {
    if (!fs.existsSync(dataFile)) {
        throw new Error(`Legacy data file not found: ${dataFile}`);
    }

    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const pool = getPool();
    const client = await pool.connect();

    try {
        await client.query('BEGIN');

        const adminMap = new Map();
        for (const admin of data.admins || []) {
            const result = await client.query(`
                INSERT INTO app_users(username,password_hash,role,active,created_at)
                VALUES($1,$2,'admin',TRUE,COALESCE($3::timestamptz,NOW()))
                ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash
                RETURNING id
            `, [admin.username, admin.password, admin.createdAt || null]);
            adminMap.set(admin.id, result.rows[0].id);
        }

        const resellerMap = new Map();
        for (const reseller of data.resellers || []) {
            const user = await client.query(`
                INSERT INTO app_users(username,password_hash,role,active,created_at)
                VALUES($1,$2,'reseller',$3,COALESCE($4::timestamptz,NOW()))
                ON CONFLICT(username) DO UPDATE SET password_hash=EXCLUDED.password_hash,active=EXCLUDED.active
                RETURNING id
            `, [reseller.username, reseller.password || bcrypt.hashSync(cryptoSafeFallback(), 12), reseller.active !== false, reseller.createdAt || null]);

            const rr = await client.query(`
                INSERT INTO resellers(user_id,credits,trial_credits,note,created_at)
                VALUES($1,$2,$3,$4,COALESCE($5::timestamptz,NOW()))
                ON CONFLICT(user_id) DO UPDATE SET credits=EXCLUDED.credits,trial_credits=EXCLUDED.trial_credits,note=EXCLUDED.note
                RETURNING id
            `, [user.rows[0].id, Math.max(0, reseller.credits || 0), Math.max(0, Math.min(20, reseller.trialCredits || 0)), reseller.note || '', reseller.createdAt || null]);
            resellerMap.set(reseller.id, rr.rows[0].id);
        }

        let defaultServerId = null;
        if (process.env.JELLYFIN_URL && process.env.JELLYFIN_API_KEY && process.env.DATA_ENCRYPTION_KEY) {
            const server = await client.query(`
                INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority)
                VALUES($1,$2,$3,$4,$5,$6,TRUE,10)
                ON CONFLICT(slug) DO UPDATE SET base_url=EXCLUDED.base_url,public_url=EXCLUDED.public_url,api_key_encrypted=EXCLUDED.api_key_encrypted
                RETURNING id
            `, [process.env.LEGACY_SERVER_NAME || 'Primary Jellyfin', process.env.LEGACY_SERVER_SLUG || 'primary', process.env.LEGACY_SERVER_CLASS || 'premium', process.env.JELLYFIN_URL, process.env.JELLYFIN_PUBLIC_URL || process.env.JELLYFIN_URL, encryptString(process.env.JELLYFIN_API_KEY)]);
            defaultServerId = server.rows[0].id;
        }

        for (const c of data.clients || []) {
            const resellerId = resellerMap.get(c.resellerId) || null;
            const customer = await client.query(`
                INSERT INTO customers(reseller_id,display_name,note,created_at)
                VALUES($1,$2,$3,COALESCE($4::timestamptz,NOW()))
                RETURNING id
            `, [resellerId, c.username, c.note || '', c.createdAt || null]);
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
        console.log(`Imported ${(data.admins || []).length} admins, ${(data.resellers || []).length} resellers and ${(data.clients || []).length} clients.`);
        console.log('Legacy client passwords are intentionally not imported. Reset them if they must be re-shared.');
    } catch (err) {
        await client.query('ROLLBACK');
        throw err;
    } finally {
        client.release();
        await pool.end();
    }
}

function cryptoSafeFallback() {
    return require('crypto').randomBytes(32).toString('base64url');
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
