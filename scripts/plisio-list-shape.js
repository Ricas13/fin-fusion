'use strict';

// READ-ONLY diagnostic. Calls Plisio's transaction LIST endpoint once with your configured key and prints only the SHAPE of the
// answer: field names, value types, which fields are present, and the ordering DIRECTION. It prints no values at all, except
// values of a few fixed, non-identifying enumerations (status/type/currency codes) and paging counters whose NAMES say they are
// paging. Never the API key, addresses, hashes, amounts, timestamps, links or customer data.
//
//   docker compose exec -T app node scripts/plisio-list-shape.js
//
// The output is safe to paste back: it is what the automatic Plisio sweep needs to be built against exact, verified fields.

require('dotenv').config();
const plisio = require('../src/payments/plisio');
const { getPool } = require('../src/db');

// Values are printed only for these names AND only when they look like a short enumeration code (letters, digits, space, _ or -),
// never free text: anything else prints as string:unrecognised.
const SAFE_VALUE_KEYS = new Set(['status', 'type', 'source_currency', 'currency_code']);
// Exact allowlists, never a pattern: a value is printed only if it is one of these known codes, so free text (a name, an email,
// an amount) can never pass however short or plain it looks. Anything else prints as 'unrecognised'.
const KNOWN_VALUES = Object.freeze({
    status: new Set(['new', 'pending', 'pending internal', 'expired', 'completed', 'cancelled', 'cancelled duplicate', 'error', 'mismatch']),
    type: new Set(['invoice', 'cash_in', 'cash_out', 'mass_cash_out', 'withdraw', 'withdrawal']),
    source_currency: new Set(['GBP', 'USD', 'EUR', 'CAD', 'AUD', 'CHF', 'JPY', 'SEK', 'NOK', 'DKK', 'PLN', 'CZK', 'TRY']),
    currency_code: new Set(['BTC', 'ETH', 'LTC', 'BCH', 'DOGE', 'XMR', 'ZEC', 'DASH', 'TRX', 'BNB', 'SOL', 'XRP', 'TON', 'USDT', 'USDC', 'USDT_TRX', 'USDT_BSC', 'USDT_ETH', 'USDC_ETH'])
});
function enumLabel(key, value) {
    return KNOWN_VALUES[key]?.has(value) ? value : 'unrecognised';
}
// Field NAMES come from the provider too: only plain identifier-style names are printed.
function safeKey(key) {
    return /^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(String(key)) ? String(key) : '(other)';
}
// Numeric top-level fields are printed only when their name is plainly a paging counter.
const PAGING_COUNTER = /^(page|pages|page_size|per_page|perPage|current_page|currentPage|last_page|total_pages|totalCount|pageCount)$/i; // unambiguous only: 'total'/'count'/'from'/'to' could be money
const DATE_KEYS = ['created_at', 'updated_at', 'created_at_utc', 'created', 'date', 'expire_utc', 'expire_at', 'tx_created_at'];

function describe(value, depth = 0) {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array(${value.length})`;
    if (typeof value === 'object') return depth > 0 ? 'object' : 'object{' + Object.keys(value).map(safeKey).join(',') + '}';
    return typeof value;
}

function shapeOf(item) {
    const out = {};
    for (const [key, value] of Object.entries(item || {})) {
        const name = safeKey(key);
        out[name] = SAFE_VALUE_KEYS.has(key) && typeof value === 'string' ? `string:${enumLabel(key, value)}` : describe(value, 1);
        if (key === 'params' && value && typeof value === 'object') out.params = `object{${Object.keys(value).map(safeKey).join(',')}}`;
    }
    return out;
}

function arrayOf(data) {
    if (Array.isArray(data)) return { where: '(data itself)', items: data };
    for (const [key, value] of Object.entries(data || {})) if (Array.isArray(value)) return { where: `data.${safeKey(key)}`, items: value };
    return { where: null, items: [] };
}

// Counts of the enumerated codes seen across the items (status/type/currency), e.g. "status: completed=3,new=2". Only short codes
// that look like enumerations are counted; anything else is counted as 'unrecognised'.
function enumSummary(items) {
    const lines = [];
    for (const key of SAFE_VALUE_KEYS) {
        const counts = {};
        for (const item of items) {
            const value = item && typeof item[key] === 'string' ? item[key] : null;
            if (value == null) continue;
            const label = enumLabel(key, value);
            counts[label] = (counts[label] || 0) + 1;
        }
        const text = Object.entries(counts).map(([label, n]) => `${label}=${n}`).join(',');
        if (text) lines.push(`${key} values: ${text}`);
    }
    return lines;
}

// Pure: turns a list response into the lines that are printed. Exported so a test can feed it hostile data.
function reportLines(data, params) {
    const lines = [];
    const { where, items } = arrayOf(data);
    lines.push(`request ${JSON.stringify(params)} ok`);
    lines.push(`top-level keys: ${data && typeof data === 'object' ? Object.keys(data).map(safeKey).join(',') : describe(data)}`);
    if (data && typeof data === 'object' && !Array.isArray(data)) {
        const meta = {};
        for (const [key, value] of Object.entries(data)) {
            if (Array.isArray(value)) continue;
            meta[safeKey(key)] = describe(value, 1) + (typeof value === 'number' && PAGING_COUNTER.test(key) ? `=${value}` : '');
            // Nested containers (for example a pagination object) are listed by key name and type only.
            if (value && typeof value === 'object') meta[safeKey(key)] = `object{${Object.entries(value).map(([k, v]) => `${safeKey(k)}:${describe(v, 1)}${typeof v === 'number' && PAGING_COUNTER.test(k) ? `=${v}` : ''}`).join(',')}}`;
        }
        lines.push(`non-list fields (paging etc): ${JSON.stringify(meta)}`);
    }
    lines.push(`list located at: ${where} items returned: ${items.length}`);
    items.slice(0, 2).forEach((item, index) => lines.push(`item ${index} shape: ${JSON.stringify(shapeOf(item))}`));
    const present = key => items.filter(item => item && (item[key] != null || item.params?.[key] != null)).length;
    lines.push(...enumSummary(items));
    lines.push('items having txn_id/id/order_number/source_amount/source_currency/status: '
        + ['txn_id', 'id', 'order_number', 'source_amount', 'source_currency', 'status'].map(key => `${key}=${present(key)}`).join(' '));
    for (const key of DATE_KEYS) {
        const stamps = items.map(item => Date.parse(item?.[key])).filter(Number.isFinite);
        if (stamps.length < 2) continue;
        let up = 0, down = 0;
        for (let i = 1; i < stamps.length; i++) { if (stamps[i] > stamps[i - 1]) up++; else if (stamps[i] < stamps[i - 1]) down++; }
        lines.push(`ordering by ${key}: ${down && !up ? 'newest-first' : up && !down ? 'oldest-first' : up || down ? 'mixed' : 'all equal'} (${stamps.length} dated items; no timestamps printed)`);
    }
    return lines;
}

// Plisio answered the first request with an empty list, so try the other documented/likely ways to ask for transactions. Every request is
// a read-only GET; the output of each is shape-only (see reportLines).
const ATTEMPTS = [
    { page: 1, page_size: 5 },
    { page: 1, 'per-page': 5 },
    { page: 1, limit: 5 },
    { page: 1, 'per-page': 5, type: 'invoice' },
    { page: 1, 'per-page': 5, type: 'cash_in' },
    { page: 1, 'per-page': 5, status: 'completed' },
    { page: 1, 'per-page': 5, status: 'expired' },
    { page: 1, 'per-page': 5, status: 'new' }
];

async function main() {
    for (const params of ATTEMPTS) {
        let data;
        try {
            data = await plisio.api('/api/v1/operations', params, { quiet: true });
        } catch (error) {
            console.log(`request ${JSON.stringify(params)} failed (httpStatus=${error?.providerStatus ?? 'n/a'})`);
            continue;
        }
        reportLines(data, params).forEach(line => console.log(line));
        console.log('---');
    }
}

module.exports = { reportLines };

if (require.main === module) {
    main().catch(() => { console.error('diagnostic failed'); process.exitCode = 1; })
        .finally(() => getPool().end().catch(() => {}));
}
