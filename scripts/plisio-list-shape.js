'use strict';

// READ-ONLY diagnostic. Calls Plisio's transaction LIST endpoint once with your configured key and prints only the SHAPE of the
// answer (field names, value types, paging, ordering). It never prints the API key, addresses, hashes, amounts or customer data.
//
//   docker compose exec -T app node scripts/plisio-list-shape.js
//
// The output is safe to paste back: it is what the automatic Plisio sweep needs to be built against exact, verified fields.

require('dotenv').config();
const plisio = require('../src/payments/plisio');
const { getPool } = require('../src/db');

const SAFE_VALUE_KEYS = new Set(['status', 'type', 'currency', 'source_currency', 'psys_cid', 'currency_code']);
const DATE_KEYS = ['created_at', 'updated_at', 'created_at_utc', 'created', 'date', 'expire_utc', 'expire_at', 'tx_created_at'];

function describe(value, depth = 0) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'object') return depth > 0 ? 'object' : 'object{' + Object.keys(value).join(',') + '}';
    return typeof value;
}

function shapeOf(item) {
    const out = {};
    for (const [key, value] of Object.entries(item || {})) {
        out[key] = SAFE_VALUE_KEYS.has(key) && typeof value === 'string' ? `${describe(value)}:${value}` : describe(value, 1);
        if (key === 'params' && value && typeof value === 'object') out.params = `object{${Object.keys(value).join(',')}}`;
    }
    return out;
}

function arrayOf(data) {
    if (Array.isArray(data)) return { where: '(data itself)', items: data };
    for (const [key, value] of Object.entries(data || {})) if (Array.isArray(value)) return { where: `data.${key}`, items: value };
    return { where: null, items: [] };
}

async function main() {
    const attempts = [
        { page: 1, page_size: 5 },
        { page: 1, limit: 5 }
    ];
    for (const params of attempts) {
        let data;
        try {
            data = await plisio.api('/api/v1/operations', params);
        } catch (error) {
            console.log(`request with ${JSON.stringify(params)} failed: ${String(error?.message || error).slice(0, 120)} (httpStatus=${error?.providerStatus ?? 'n/a'})`);
            continue;
        }
        const { where, items } = arrayOf(data);
        console.log(`request ${JSON.stringify(params)} ok`);
        console.log('top-level keys:', data && typeof data === 'object' ? Object.keys(data).join(',') : describe(data));
        if (data && typeof data === 'object' && !Array.isArray(data)) {
            const meta = {};
            for (const [key, value] of Object.entries(data)) if (!Array.isArray(value)) meta[key] = describe(value, 1) + (typeof value === 'number' ? `=${value}` : '');
            console.log('non-list fields (paging etc):', JSON.stringify(meta));
        }
        console.log('list located at:', where, 'items returned:', items.length);
        items.slice(0, 2).forEach((item, index) => console.log(`item ${index} shape:`, JSON.stringify(shapeOf(item))));
        const present = key => items.filter(item => item && (item[key] != null || item.params?.[key] != null)).length;
        console.log('items having txn_id/id/order_number/source_amount/source_currency/status:',
            ['txn_id', 'id', 'order_number', 'source_amount', 'source_currency', 'status'].map(key => `${key}=${present(key)}`).join(' '));
        for (const key of DATE_KEYS) {
            const values = items.map(item => item?.[key]).filter(value => value != null);
            if (values.length > 1) console.log(`ordering by ${key}: first=${values[0]} last=${values[values.length - 1]} (shows newest-first or oldest-first)`);
        }
        break;
    }
}

main().catch(error => { console.error('diagnostic failed:', String(error?.message || error).slice(0, 200)); process.exitCode = 1; })
    .finally(() => getPool().end().catch(() => {}));
