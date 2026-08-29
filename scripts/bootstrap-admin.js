'use strict';

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { getPool } = require('../src/db');

function cleanUsername(value) {
    const username = String(value || '').trim();
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(username)) {
        throw new Error('ADMIN_USERNAME must be 3-40 characters using letters, numbers, dot, underscore or dash');
    }
    return username;
}

function validatePassword(value) {
    const password = String(value || '');
    if (password.length < 12 || password.length > 200) {
        throw new Error('ADMIN_PASSWORD must be between 12 and 200 characters for first bootstrap');
    }
    if (password === 'admin123') throw new Error('ADMIN_PASSWORD may not use the legacy admin123 password');
    return password;
}

async function main() {
    const pool = getPool();
    const client = await pool.connect();
    try {
        const existing = await client.query(`
            SELECT id,username FROM app_users
            WHERE role='admin'
            ORDER BY created_at ASC
            LIMIT 1
        `);
        if (existing.rowCount) {
            console.log(`native admin bootstrap: existing administrator ${existing.rows[0].username} preserved`);
            return;
        }

        const hasUsername = Boolean(String(process.env.ADMIN_USERNAME || '').trim());
        const hasPassword = Boolean(String(process.env.ADMIN_PASSWORD || ''));
        if (!hasUsername && !hasPassword) {
            console.log('native admin bootstrap: no environment credentials supplied; browser first-run setup remains available at /setup');
            return;
        }
        if (!hasUsername || !hasPassword) {
            throw new Error('Set both ADMIN_USERNAME and ADMIN_PASSWORD, or leave both unset to use browser first-run setup');
        }

        const username = cleanUsername(process.env.ADMIN_USERNAME);
        const password = validatePassword(process.env.ADMIN_PASSWORD);
        const emailRaw = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
        const email = emailRaw && emailRaw.includes('@') && emailRaw.length <= 254 ? emailRaw : null;
        const passwordHash = await bcrypt.hash(password, 12);

        await client.query('BEGIN');
        const legacyIdResult = await client.query(`
            SELECT COALESCE(MAX(legacy_numeric_id),0)::int + 1 AS next_id
            FROM app_users WHERE role='admin'
        `);
        const legacyId = Number(legacyIdResult.rows[0].next_id || 1);
        const inserted = await client.query(`
            INSERT INTO app_users(
                email,username,password_hash,role,active,legacy_numeric_id,is_owner,
                password_changed_at,email_verified_at,created_at,updated_at
            ) VALUES($1,$2,$3,'admin',TRUE,$4,TRUE,NOW(),CASE WHEN $1::text IS NULL THEN NULL ELSE NOW() END,NOW(),NOW())
            RETURNING id,username,legacy_numeric_id,is_owner
        `, [email, username, passwordHash, legacyId]);
        const adminId = inserted.rows[0].id;
        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.bootstrap','app_user',$2,$3::jsonb)
        `, [adminId, String(adminId), JSON.stringify({ username, legacyNumericId: legacyId, owner: true, source: 'environment' })]);
        await client.query('COMMIT');
        console.log(`native admin bootstrap: created ${username}`);
    } catch (error) {
        try { await client.query('ROLLBACK'); } catch (_) {}
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error(`native admin bootstrap failed: ${error.message}`);
    process.exit(1);
});
