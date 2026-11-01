'use strict';

// The diagnostic must print only the SHAPE of Plisio's list response. Feed it hostile data and prove nothing sensitive is printed.
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const assert = require('assert');
const { reportLines } = require('./plisio-list-shape');

const SECRET = 'SECRETKEY-abc123';
const hostile = {
    status: 'success',
    total: 42,
    count: 7,
    from: 3,
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
        { txn_id: 'TXN-SENSITIVE-3', status: 'customer@example.com', type: 'Alice Smith paid GBP 50 from wallet', source_currency: 'GBP 123.45 total', currency_code: 'x'.repeat(64) },
        { txn_id: 'TXN-SENSITIVE-2', order_number: 'ORDER-SENSITIVE-2', status: 'new', type: 'invoice', source_amount: '5.00', source_currency: 'GBP',
          created_at: '2026-09-30T10:00:00Z' }
    ]
};

const out = reportLines(hostile, { page: 1, page_size: 5 }).join('\n');
for (const forbidden of [SECRET, 'api_key=', 'customer@example.com', 'SENSITIVE', '123.45', '999.99', '5.00', '987654321', '555', 'blockchair', 'bc1q', '2026-10-01', '2026-09-30', 'next_url=http', 'https://']) {
    assert(!out.includes(forbidden), `diagnostic output must not contain ${forbidden}`);
}
for (const forbidden of ['=42', '=7', '=3"', 'Alice', 'paid GBP', 'from wallet']) {
    assert(!out.includes(forbidden), `ambiguous numbers and free-text enum values must not print (${forbidden})`);
}
assert(out.includes('string:unrecognised'), 'a free-text value in an enum-named field prints as unrecognised');
for (const expected of ['top-level keys', 'operations', 'txn_id', 'order_number', 'source_amount', 'newest-first', 'pages:number=9']) {
    assert(out.includes(expected), `diagnostic output should still describe ${expected}`);
}
assert(out.includes('string:completed'), 'enumerated status codes are still shown');

// The shared API client must stay silent about provider error text in quiet mode (and still log normally otherwise).
(async () => {
    const providerSettings = require('../src/payments/provider-settings');
    const plisio = require('../src/payments/plisio');
    providerSettings.get = async () => ({ secretKey: 'unit-test-key' });
    const realFetch = global.fetch, realError = console.error;
    global.fetch = async () => new Response(JSON.stringify({ status: 'error', data: { message: `bad link https://plisio.net/x?api_key=${SECRET} for customer@example.com` } }), { status: 500 });
    const logged = [];
    console.error = (...args) => logged.push(args.join(' '));
    try {
        await assert.rejects(plisio.api('/api/v1/operations', { page: 1 }, { quiet: true }));
        assert.strictEqual(logged.join('\n'), '', 'quiet mode prints nothing from the provider error');
        await assert.rejects(plisio.api('/api/v1/operations', { page: 1 }));
        assert(logged.join('\n').includes('Plisio API error (500)'), 'normal production logging is unchanged');
        // Preserve #924's strict provider-not-found classification after merging quiet mode.
        logged.length = 0;
        global.fetch = async () => new Response(JSON.stringify({ status: 'error', data: { code: 111, message: `secret ${SECRET}` } }), { status: 404 });
        await assert.rejects(
            plisio.api('/api/v1/operations/no-such-operation', {}, { quiet: true }),
            error => error.providerStatus === 404 && error.providerNotFound === true
        );
        assert.strictEqual(logged.length, 0, 'quiet 404 does not print provider-supplied text');
        global.fetch = async () => new Response(JSON.stringify({ status: 'error', data: { code: 999, message: 'other 404' } }), { status: 404 });
        await assert.rejects(
            plisio.api('/api/v1/operations/no-such-operation', {}, { quiet: true }),
            error => error.providerStatus === 404 && error.providerNotFound === false
        );
    } finally {
        global.fetch = realFetch;
        console.error = realError;
    }
    console.log('plisio list-shape smoke: ok');
})().catch(error => { console.error(error); process.exitCode = 1; });
