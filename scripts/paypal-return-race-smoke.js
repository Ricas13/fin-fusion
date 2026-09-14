'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('PayPal return/webhook race smoke')) process.exit(0);

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const livePaypalHistory = require('../src/payments/live-paypal-payment-history');

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

    const returnSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'customer-payment-return.js'), 'utf8');
    expect(returnSource.includes('intents.alreadyCompletedByOwner'), 'the PayPal return route must fall back to alreadyCompletedByOwner() on a verify() failure.');

    const capture = {
        id: `PAYPAL-CAPTURE-${suffix}`,
        status: 'COMPLETED',
        create_time: '2026-09-13T12:00:00Z',
        amount: { currency_code: 'USD', value: '30.00' },
        seller_receivable_breakdown: {
            paypal_fee: { currency_code: 'USD', value: '1.47' },
            net_amount: { currency_code: 'USD', value: '28.53' }
        },
        supplementary_data: { related_ids: { order_id: `PAYPAL-ORDER-${suffix}` } }
    };
    const history = livePaypalHistory.historyValues(capture, customer.id);
    expect(history.providerTransactionId === capture.id, 'PayPal capture ID must be the canonical ledger dedupe key.');
    expect(history.grossMinor === 3000, '$30 PayPal payment must be recorded as 3000 minor units.');
    expect(history.feeMinor === 147, 'PayPal fee must come from seller_receivable_breakdown.');
    expect(history.netMinor === 2853, 'PayPal net proceeds must remain provider-authoritative.');
    expect(history.status === 'S', 'completed PayPal captures must use the canonical successful accounting status.');
    expect(livePaypalHistory.historyValues({ ...capture, status: 'PENDING' }, customer.id) === null, 'pending PayPal captures must never become revenue.');
    expect(livePaypalHistory.historyValues({ ...capture, seller_receivable_breakdown: {} }, customer.id) === null, 'missing PayPal fee/net data must never be guessed.');

    const ledgerSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'live-paypal-payment-history.js'), 'utf8');
    const webhookSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'webhooks.js'), 'utf8');
    expect(ledgerSource.includes('ON CONFLICT(provider,provider_transaction_id) DO UPDATE'), 'PayPal webhook retries must upsert rather than double count.');
    expect(ledgerSource.includes("LIVE_CAPTURE_PAYMENT_TYPE = 'T0006'"), 'live PayPal captures must map to the canonical PayPal payment classification.');
    expect(ledgerSource.includes('providerAuthoritative: true'), 'provider-verified PayPal rows must be marked authoritative.');
    expect(!/INSERT\s+INTO\s+subscriptions/i.test(ledgerSource), 'accounting sync must never create entitlement state.');
    expect(!/UPDATE\s+subscriptions/i.test(ledgerSource), 'accounting sync must never mutate entitlement state.');
    expect(webhookSource.includes("require('../payments/live-paypal-payment-history')"), 'verified PayPal webhooks must load the live ledger writer.');
    expect(webhookSource.includes('await livePaypalHistory.recordVerifiedWebhook(req.body)'), 'PayPal ledger persistence must run after provider webhook verification/processing.');
    expect(webhookSource.includes("res.status(503).json({received:true,deferred:true,accounting:true})"), 'ledger persistence failures must keep PayPal redelivery alive.');

    console.log('PayPal return/webhook race smoke test passed.');
}

main().finally(() => getPool().end());
