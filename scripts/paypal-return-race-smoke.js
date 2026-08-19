'use strict';

require('dotenv').config();
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');

function expect(condition, message) { if (!condition) throw new Error(message); }

async function main() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Race Test',$1) RETURNING id`, [`race-${suffix}@example.invalid`])).rows[0];
    const other = (await query(`INSERT INTO customers(display_name,email) VALUES('Other',$1) RETURNING id`, [`race-other-${suffix}@example.invalid`])).rows[0];

    const created = await intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'paypal', checkoutMode: 'payment', commercialSnapshot: {} });
    const nonce = created.nonce;
    await intents.attachProviderCheckout(created.id, `PAYPAL-ORDER-${suffix}`);

    // Simulate the provider webhook winning the race: it completes the intent
    // (the same path webhooks.js uses) before the browser's own return request
    // is processed -- this is what customer-payment-return.js must tolerate.
    await intents.completeVerifiedProvider('paypal', `PAYPAL-ORDER-${suffix}`, 'completed');

    let verifyThrew = false;
    try {
        await intents.verify({ intentId: created.id, nonce, scope: 'customer', provider: 'paypal', ownerId: customer.id });
    } catch (_) {
        verifyThrew = true;
    }
    expect(verifyThrew, 'verify() should still reject a non-open intent -- this smoke exists to check the fallback, not weaken verify().');

    const already = await intents.alreadyCompletedByOwner({ intentId: created.id, nonce, scope: 'customer', provider: 'paypal', ownerId: customer.id });
    expect(already, 'alreadyCompletedByOwner() must recognize a webhook-completed intent so the return handler can redirect to success instead of a false "expired/already used" error.');

    const wrongNonce = await intents.alreadyCompletedByOwner({ intentId: created.id, nonce: 'not-the-real-nonce', scope: 'customer', provider: 'paypal', ownerId: customer.id });
    expect(wrongNonce === null, 'alreadyCompletedByOwner() must not be usable to probe intent state without the real nonce.');

    const wrongOwner = await intents.alreadyCompletedByOwner({ intentId: created.id, nonce, scope: 'customer', provider: 'paypal', ownerId: other.id });
    expect(wrongOwner === null, 'alreadyCompletedByOwner() must not leak another customer\'s completed checkout.');

    const returnSource = require('fs').readFileSync(require('path').join(__dirname, '..', 'src', 'platform', 'customer-payment-return.js'), 'utf8');
    expect(returnSource.includes('intents.alreadyCompletedByOwner'), 'the PayPal return route must fall back to alreadyCompletedByOwner() on a verify() failure.');

    console.log('PayPal return/webhook race smoke test passed.');
}

main().finally(() => getPool().end());
