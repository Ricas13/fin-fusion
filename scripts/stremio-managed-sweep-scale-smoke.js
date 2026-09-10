'use strict';

const assert = require('assert');

process.env.STREMIO_MANAGED_SWEEP_BATCH_SIZE = '10';
process.env.STREMIO_MANAGED_SWEEP_CONCURRENCY = '2';

const sweep = require('../src/stremio/managed-entitlement-sweep');

function uuid(n) {
    return `00000000-0000-0000-0000-${String(n).padStart(12, '0')}`;
}

const cursorState = new Map();
const cursorStore = {
    async load(key) { return cursorState.get(key) || null; },
    async save(key, value) { cursorState.set(key, value); return value; },
    async clear(key) { cursorState.delete(key); return null; }
};

const inactiveRows = Array.from({ length: 11 }, (_, index) => ({
    mapping_id: uuid(index + 1),
    customer_id: uuid(100 + index),
    server_id: uuid(200 + index),
    jellyfin_account_id: uuid(300 + index),
    jellyfin_user_id: `remote-${index + 1}`,
    jellyfin_username: `hidden-${index + 1}`,
    server_name: 'Stremio Test',
    base_url: 'https://stremio.example.test',
    media_server_type: 'jellyfin',
    access_token_encrypted: 'not-used'
}));
const activeRows = Array.from({ length: 11 }, (_, index) => ({
    id: uuid(500 + index),
    customer_id: uuid(600 + index),
    plan_id: uuid(700 + index)
}));

const queries = [];
async function fakeQuery(sql, params = []) {
    queries.push({ sql, params });
    if (sql.includes('FROM stremio_managed_accounts sma')) {
        assert(sql.includes('ORDER BY sma.id'));
        assert(sql.includes('LIMIT $'));
        return { rows: inactiveRows };
    }
    if (sql.includes('FROM stremio_entitlements e')) {
        assert(sql.includes('ORDER BY e.id'));
        assert(sql.includes('LIMIT $'));
        return { rows: activeRows };
    }
    throw new Error(`Unexpected query in Stremio scale smoke: ${sql.slice(0, 120)}`);
}

let inFlight = 0;
let maxInFlight = 0;
async function boundedWorker() {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise(resolve => setTimeout(resolve, 2));
    inFlight -= 1;
    return { ok: true };
}

let wakeCount = 0;
(async () => {
    const result = await sweep.syncActiveBounded({
        queryFn: fakeQuery,
        cursorStore,
        disableFn: boundedWorker,
        mappingFn: boundedWorker,
        wakeFn: async () => { wakeCount += 1; }
    });

    assert.strictEqual(result.inactive.total, 10, 'inactive cleanup must process only one bounded page');
    assert.strictEqual(result.active.total, 10, 'active synchronization must process only one bounded page');
    assert.strictEqual(result.total, 20);
    assert.strictEqual(result.processed, 20);
    assert.strictEqual(result.failed, 0);
    assert.strictEqual(result.hasMore, true);
    assert.strictEqual(wakeCount, 1, 'a healthy partial scan must immediately request the next page');
    assert(maxInFlight <= 2, `managed Stremio sweep exceeded configured concurrency: ${maxInFlight}`);
    assert.strictEqual(cursorState.get(sweep.INACTIVE_SCAN_KEY), uuid(10));
    assert.strictEqual(cursorState.get(sweep.ACTIVE_SCAN_KEY), uuid(509));
    assert.strictEqual(queries.length, 2, 'one bounded query per independent scan is expected');
    assert(queries.every(entry => Number(entry.params.at(-1)) === 11), 'queries must fetch only batch+1 rows to detect continuation');

    console.log('stremio managed sweep scale smoke: ok');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
