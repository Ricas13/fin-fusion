require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { getPool } = require('../src/db');

async function main() {
    const dir = path.join(__dirname, '..', 'db', 'migrations');
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();
    const pool = getPool();

    await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
        filename TEXT PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);

    for (const filename of files) {
        const exists = await pool.query('SELECT 1 FROM schema_migrations WHERE filename=$1', [filename]);
        if (exists.rowCount) {
            console.log(`skip ${filename}`);
            continue;
        }

        const sql = fs.readFileSync(path.join(dir, filename), 'utf8');
        const client = await pool.connect();
        try {
            await client.query('BEGIN');
            await client.query(sql);
            await client.query('INSERT INTO schema_migrations(filename) VALUES($1)', [filename]);
            await client.query('COMMIT');
            console.log(`applied ${filename}`);
        } catch (err) {
            await client.query('ROLLBACK');
            throw err;
        } finally {
            client.release();
        }
    }

    await pool.end();
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
