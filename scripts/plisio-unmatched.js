'use strict';

// READ-ONLY, for the operator's own terminal. Lists the completed Plisio payments that match no checkout and are not in the ledger
// (the ones the "Plisio payment check" job warns about), with enough detail to recognise each one in Plisio's dashboard.
// It never writes anything and never grants access.
//
//   docker compose exec -T app npm run plisio:unmatched

require('dotenv').config();
const sweep = require('../src/payments/plisio-sweep');

// Only these fields are printed (no wallet address, hash, link or customer email).
const FIELDS = ['txn_id', 'order_number', 'order_name', 'status', 'type', 'source_amount', 'source_currency', 'currency', 'amount', 'actual_sum', 'created_at', 'created_at_utc', 'tx_created_at', 'expire_utc'];
const SAFE = /^[\w .:+\/@-]{0,120}$/;

// Pure: one printable block for an operation.
function describe(operation) {
    const lines = [];
    for (const key of FIELDS) {
        const raw = operation?.[key] ?? operation?.params?.[key];
        if (raw == null || typeof raw === 'object') continue;
        const value = String(raw);
        lines.push(`  ${key}: ${SAFE.test(value) ? value : '(not shown)'}`);
    }
    return lines.join('\n') || '  (no recognised fields)';
}

async function main() {
    const plisio = require('../src/payments/plisio');
    const { query, getPool } = require('../src/db');
    try {
        const scanned = await sweep.scan({ apiFn: plisio.api });
        if (scanned.structural.length || scanned.failed) { console.log(`Cannot list payments safely (${scanned.structural.join(',') || scanned.failed}).`); return; }
        const compared = await sweep.compare(scanned.operations, query);
        console.log(`Completed at Plisio: ${scanned.operations.length}. Settled here: ${compared.settled.length}. Unmatched: ${compared.unmatched.length}. Open here: ${compared.pending.length}. Closed here: ${compared.closed.length}.${scanned.incomplete ? ' (partial scan)' : ''}`);
        for (const [label, ids] of [['UNMATCHED (no checkout, not in ledger)', compared.unmatched], ['COMPLETED AT PLISIO BUT OPEN HERE', compared.pending], ['COMPLETED AT PLISIO BUT CLOSED HERE', compared.closed]]) {
            if (!ids.length) continue;
            console.log(`\n${label}`);
            for (const id of ids) {
                let detail;
                try { detail = await plisio.api(`/api/v1/operations/${encodeURIComponent(id)}`, {}, { quiet: true }); } catch (_) { detail = { txn_id: id }; }
                console.log(describe(detail?.operation || detail));
                console.log('  ---');
            }
        }
    } finally {
        await getPool().end().catch(() => {});
    }
}

module.exports = { describe };

if (require.main === module) main().catch(() => { console.error('diagnostic failed'); process.exitCode = 1; });
