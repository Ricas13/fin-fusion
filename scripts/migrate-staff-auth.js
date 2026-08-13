'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');

const dataFile = process.env.LEGACY_DATA_FILE || path.join(__dirname, '..', 'db', 'data.json');

async function upsertStaff(client, row, role) {
    if (!row?.username || !row?.password || !Number.isInteger(Number(row.id))) return false;
    const result = await client.query(`
        INSERT INTO app_users(
            username,password_hash,role,active,legacy_numeric_id,password_changed_at,created_at,updated_at
        ) VALUES($1,$2,$3,$4,$5,COALESCE($6::timestamptz,NOW()),COALESCE($7::timestamptz,NOW()),NOW())
        ON CONFLICT(username) DO UPDATE SET
            legacy_numeric_id=EXCLUDED.legacy_numeric_id,
            active=EXCLUDED.active,
            updated_at=NOW()
        WHERE app_users.role=EXCLUDED.role
        RETURNING id,username,role,legacy_numeric_id
    `, [
        row.username,
        row.password,
        role,
        row.active !== false,
        Number(row.id),
        row.passwordChangedAt || null,
        row.createdAt || null
    ]);
    if (!result.rowCount) throw new Error(`Role mismatch for existing user ${row.username}`);
    return true;
}

async function main() {
    if (!fs.existsSync(dataFile)) throw new Error(`Legacy data file not found: ${dataFile}`);
    const data = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
    const pool = getPool();
    const client = await pool.connect();
    let admins = 0;
    let resellers = 0;
    try {
        await client.query('BEGIN');
        for (const row of data.admins || []) if (await upsertStaff(client, row, 'admin')) admins += 1;
        for (const row of data.resellers || []) if (await upsertStaff(client, row, 'reseller')) resellers += 1;
        await client.query('COMMIT');
        console.log(`Staff auth migration complete: admins=${admins}, resellers=${resellers}`);
        console.log('Existing PostgreSQL password hashes were preserved on conflict.');
    } catch (error) {
        await client.query('ROLLBACK');
        throw error;
    } finally {
        client.release();
        await pool.end();
    }
}

main().catch(error => {
    console.error(error.message);
    process.exit(1);
});
