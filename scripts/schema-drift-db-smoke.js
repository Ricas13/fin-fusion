'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');

const migrationsDir = path.join(__dirname, '..', 'db', 'migrations');

function cleanIdentifier(raw) {
    return String(raw || '')
        .replace(/^public\./i, '')
        .replace(/^"|"$/g, '')
        .toLowerCase();
}

function tableOperations(sql) {
    const operations = [];
    const expression = /\b(CREATE\s+(?:UNLOGGED\s+)?TABLE(?:\s+IF\s+NOT\s+EXISTS)?|DROP\s+TABLE(?:\s+IF\s+EXISTS)?|ALTER\s+TABLE(?:\s+IF\s+EXISTS)?(?:\s+ONLY)?)\s+((?:public\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?)(?:\s+RENAME\s+TO\s+((?:public\.)?"?[a-zA-Z_][a-zA-Z0-9_]*"?))?/gim;
    let match;
    while ((match = expression.exec(sql)) !== null) {
        const verb = match[1].toUpperCase();
        const table = cleanIdentifier(match[2]);
        if (verb.startsWith('CREATE')) operations.push({ type: 'create', table, offset: match.index });
        else if (verb.startsWith('DROP')) operations.push({ type: 'drop', table, offset: match.index });
        else if (match[3]) operations.push({ type: 'rename', table, next: cleanIdentifier(match[3]), offset: match.index });
    }
    return operations.sort((a, b) => a.offset - b.offset);
}

function expectedTables(files) {
    const tables = new Set(['schema_migrations']);
    for (const filename of files) {
        const sql = fs.readFileSync(path.join(migrationsDir, filename), 'utf8');
        for (const op of tableOperations(sql)) {
            if (op.type === 'create') tables.add(op.table);
            else if (op.type === 'drop') tables.delete(op.table);
            else if (op.type === 'rename') {
                tables.delete(op.table);
                tables.add(op.next);
            }
        }
    }
    return tables;
}

function difference(left, right) {
    return [...left].filter(value => !right.has(value)).sort();
}

async function main() {
    const files = fs.readdirSync(migrationsDir).filter(name => name.endsWith('.sql')).sort();
    assert(files.length > 0, 'No SQL migrations found');

    const expected = expectedTables(files);
    const actualRows = await query(`
        SELECT tablename
        FROM pg_catalog.pg_tables
        WHERE schemaname='public'
        ORDER BY tablename
    `);
    const actual = new Set(actualRows.rows.map(row => String(row.tablename).toLowerCase()));

    const missing = difference(expected, actual);
    const unmanaged = difference(actual, expected);
    assert.deepStrictEqual(missing, [], `Migrated database is missing tables declared by the migration history: ${missing.join(', ')}`);
    assert.deepStrictEqual(unmanaged, [], `Public schema contains unmanaged tables not owned by the migration history: ${unmanaged.join(', ')}`);

    const ledger = await query('SELECT filename,checksum FROM public.schema_migrations ORDER BY filename');
    const ledgerFiles = ledger.rows.map(row => row.filename);
    assert.deepStrictEqual(ledgerFiles, files, 'schema_migrations ledger does not exactly match the checked-in migration set');
    assert(ledger.rows.every(row => /^[0-9a-f]{64}$/i.test(String(row.checksum || ''))), 'Every applied migration must retain a SHA-256 checksum');

    const fingerprint = crypto.createHash('sha256').update([...actual].sort().join('\n')).digest('hex');
    console.log(`schema drift DB smoke: ${actual.size} migration-owned public tables, fingerprint ${fingerprint}`);
}

main().then(() => getPool().end()).catch(async error => {
    console.error(error.stack || error);
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});
