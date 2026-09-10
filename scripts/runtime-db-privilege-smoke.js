'use strict';

require('dotenv').config();
const { getPool } = require('../src/db');

const RUNTIME_ROLES = Object.freeze(['steamfusion_app', 'steamfusion_automation']);

function collectMissing(role, kind, rows, checks) {
    const missing = [];
    for (const row of rows) {
        for (const [column, privilege] of checks) {
            if (!row[column]) missing.push(`${role} missing ${privilege} on ${kind} ${row.object_name}`);
        }
    }
    return missing;
}

async function main() {
    const pool = getPool();
    const client = await pool.connect();
    try {
        const missing = [];

        for (const role of RUNTIME_ROLES) {
            const roleResult = await client.query('SELECT 1 FROM pg_roles WHERE rolname = $1', [role]);
            if (!roleResult.rowCount) {
                missing.push(`${role} does not exist`);
                continue;
            }

            const schemaResult = await client.query(
                "SELECT has_schema_privilege($1, 'public', 'USAGE') AS can_usage",
                [role]
            );
            if (!schemaResult.rows[0]?.can_usage) missing.push(`${role} missing USAGE on schema public`);

            const tableResult = await client.query(`
                SELECT
                    format('%I.%I', n.nspname, c.relname) AS object_name,
                    has_table_privilege($1, c.oid, 'SELECT') AS can_select,
                    has_table_privilege($1, c.oid, 'INSERT') AS can_insert,
                    has_table_privilege($1, c.oid, 'UPDATE') AS can_update,
                    has_table_privilege($1, c.oid, 'DELETE') AS can_delete
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind IN ('r', 'p')
                ORDER BY c.relname
            `, [role]);
            missing.push(...collectMissing(role, 'table', tableResult.rows, [
                ['can_select', 'SELECT'],
                ['can_insert', 'INSERT'],
                ['can_update', 'UPDATE'],
                ['can_delete', 'DELETE']
            ]));

            const sequenceResult = await client.query(`
                SELECT
                    format('%I.%I', n.nspname, c.relname) AS object_name,
                    has_sequence_privilege($1, c.oid, 'USAGE') AS can_usage,
                    has_sequence_privilege($1, c.oid, 'SELECT') AS can_select,
                    has_sequence_privilege($1, c.oid, 'UPDATE') AS can_update
                FROM pg_class c
                JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public'
                  AND c.relkind = 'S'
                ORDER BY c.relname
            `, [role]);
            missing.push(...collectMissing(role, 'sequence', sequenceResult.rows, [
                ['can_usage', 'USAGE'],
                ['can_select', 'SELECT'],
                ['can_update', 'UPDATE']
            ]));

            const functionResult = await client.query(`
                SELECT
                    format('%I.%I(%s)', n.nspname, p.proname, pg_get_function_identity_arguments(p.oid)) AS object_name,
                    has_function_privilege($1, p.oid, 'EXECUTE') AS can_execute
                FROM pg_proc p
                JOIN pg_namespace n ON n.oid = p.pronamespace
                WHERE n.nspname = 'public'
                ORDER BY p.proname, p.oid
            `, [role]);
            missing.push(...collectMissing(role, 'function', functionResult.rows, [
                ['can_execute', 'EXECUTE']
            ]));
        }

        if (missing.length) {
            throw new Error(`Runtime DB privilege validation failed:\n${missing.join('\n')}`);
        }

        console.log(`Runtime database privilege validation passed for ${RUNTIME_ROLES.join(', ')}`);
    } finally {
        client.release();
        await pool.end();
    }
}

if (require.main === module) {
    main().catch(error => {
        console.error(error.message);
        process.exit(1);
    });
}

module.exports = { RUNTIME_ROLES, collectMissing, main };
