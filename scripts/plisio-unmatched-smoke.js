'use strict';

// The unmatched-payment diagnostic prints only a whitelist of fields and never writes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { describe } = require('./plisio-unmatched');

const out = describe({
    txn_id: 'abc123', order_number: '3b241101-e2bb-4255-8caf-4136c566a962', status: 'completed', source_amount: '9.99', source_currency: 'GBP', created_at: '2026-10-01T10:00:00Z',
    wallet_hash: 'bc1qSECRETADDRESS', tx_url: ['https://blockchair.com/x'], email: 'customer@example.com', api_key: 'KEY', order_name: 'a\nb<script>'
});
for (const shown of ['txn_id: abc123', 'order_number: 3b241101-e2bb-4255-8caf-4136c566a962', 'source_amount: 9.99', 'source_currency: GBP', 'created_at: 2026-10-01T10:00:00Z']) assert(out.includes(shown), shown);
for (const hidden of ['SECRET', 'blockchair', 'customer@example.com', 'KEY', '<script>']) assert(!out.includes(hidden), `must not print ${hidden}`);
assert(out.includes('order_name: (not shown)'), 'free text with unusual characters is not printed');
const external=describe({txn_id:'invoice_123',order_number:'person@example.com',order_name:'A Customer',status:'https://secret.invalid',source_amount:'secret',currency:'BAD@EMAIL'});
for(const hidden of ['person@example.com','A Customer','secret.invalid','source_amount: secret','BAD@EMAIL'])assert(!external.includes(hidden),hidden);
assert(external.includes('txn_id: invoice_123'));
assert.strictEqual(describe({}), '  (no recognised fields)');
const source = fs.readFileSync(path.join(__dirname, 'plisio-unmatched.js'), 'utf8').replace(/\/\/.*$/gm, '');
assert(!/INSERT\s|UPDATE\s|DELETE\s|activatePurchase|confirmCheckout|recordTransaction/.test(source), 'read-only');
console.log('plisio unmatched smoke: ok');
