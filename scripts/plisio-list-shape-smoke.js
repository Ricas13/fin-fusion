'use strict';

// The diagnostic must print only the SHAPE of Plisio's list response. Feed it hostile data and prove nothing sensitive is printed.
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const assert = require('assert');
const { reportLines } = require('./plisio-list-shape');

const SECRET = 'SECRETKEY-abc123';
const hostile = {
    status: 'success',
    total: 42,
    page: 1,
    revenue_total: 987654321,
    api_key: SECRET,
    secret_note: 'customer@example.com paid 123.45 GBP',
    pagination: { page: 1, pages: 9, next_url: `https://plisio.net/api/v1/operations?page=2&api_key=${SECRET}`, grand_total_amount: 555 },
    _links: { self: { href: `https://plisio.net/api/v1/operations?api_key=${SECRET}` } },
    operations: [
        { txn_id: 'TXN-SENSITIVE-1', order_number: 'ORDER-SENSITIVE-1', status: 'completed', type: 'invoice', source_amount: '123.45', source_currency: 'GBP',
          wallet_hash: 'bc1qSENSITIVEADDRESS', tx_url: 'https://blockchair.com/tx/SENSITIVEHASH', email: 'customer@example.com',
          created_at: '2026-10-01T10:00:00Z', params: { source_amount: '999.99', email: 'customer@example.com' } },
        { txn_id: 'TXN-SENSITIVE-2', order_number: 'ORDER-SENSITIVE-2', status: 'new', type: 'invoice', source_amount: '5.00', source_currency: 'GBP',
          created_at: '2026-09-30T10:00:00Z' }
    ]
};

const out = reportLines(hostile, { page: 1, page_size: 5 }).join('\n');
for (const forbidden of [SECRET, 'api_key=', 'customer@example.com', 'SENSITIVE', '123.45', '999.99', '5.00', '987654321', '555', 'blockchair', 'bc1q', '2026-10-01', '2026-09-30', 'next_url=http', 'https://']) {
    assert(!out.includes(forbidden), `diagnostic output must not contain ${forbidden}`);
}
for (const expected of ['top-level keys', 'operations', 'txn_id', 'order_number', 'source_amount', 'newest-first', 'number=42', 'pages:number=9']) {
    assert(out.includes(expected), `diagnostic output should still describe ${expected}`);
}
assert(out.includes('string:completed'), 'enumerated status codes are still shown');
console.log('plisio list-shape smoke: ok');
