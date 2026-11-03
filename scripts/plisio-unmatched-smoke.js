'use strict';

// The unmatched-payment diagnostic prints only a whitelist of fields and never writes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe } = require('./plisio-unmatched');

const out = describe({
    txn_id: 'abc123', order_number: 'ord-1', status: 'completed', source_amount: '9.99', source_currency: 'GBP', created_at: '2026-10-01T10:00:00Z',
    wallet_hash: 'bc1qSECRETADDRESS', tx_url: ['https://blockchair.com/x'], email: 'customer@example.com', api_key: 'KEY', order_name: 'a\nb<script>'
});
for (const shown of ['txn_id: abc123', 'order_number: ord-1', 'source_amount: 9.99', 'source_currency: GBP', 'created_at: 2026-10-01T10:00:00Z']) assert(out.includes(shown), shown);
for (const hidden of ['SECRET', 'blockchair', 'customer@example.com', 'KEY', '<script>']) assert(!out.includes(hidden), `must not print ${hidden}`);
assert(out.includes('order_name: (not shown)'), 'free text with unusual characters is not printed');
assert.strictEqual(describe({}), '  (no recognised fields)');
const source = fs.readFileSync(path.join(__dirname, 'plisio-unmatched.js'), 'utf8').replace(/\/\/.*$/gm, '');
assert(!/INSERT\s|UPDATE\s|DELETE\s|activatePurchase|confirmCheckout|recordTransaction/.test(source), 'read-only');
console.log('plisio unmatched smoke: ok');
