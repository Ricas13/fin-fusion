'use strict';

require('dotenv').config();
const recovery = require('../src/payments/provider-operation-recovery');
const { getPool } = require('../src/db');

async function main() {
    const limitArg = process.argv.find(arg => /^--limit=/.test(arg));
    const limit = Math.max(1, Math.min(500, Number(limitArg?.split('=')[1]) || 100));
    const rows = await recovery.attention({ limit });
    const output = rows.map(row => ({
        id: row.id,
        provider: row.provider,
        owner_id: row.owner_id,
        operation_type: row.operation_type,
        state: row.state,
        attempts: Number(row.attempt_count || 0),
        failure_kind: row.failure_kind || '',
        manual_review: Boolean(row.manual_review_required),
        next_attempt_at: row.next_attempt_at || null,
        last_error: row.last_error || '',
        updated_at: row.updated_at
    }));
    if (process.argv.includes('--json')) console.log(JSON.stringify(output, null, 2));
    else if (output.length) console.table(output);
    else console.log('No unresolved provider operations.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await getPool().end(); } catch (_) {} });
