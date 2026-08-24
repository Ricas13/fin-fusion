'use strict';

require('dotenv').config();
const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('PayPal return/webhook race smoke')) process.exit(0);

const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const lifecycle = require('../src/payments/lifecycle');
const webhooks = require('../src/platform/webhooks');

function expect(condition, message) { if (!condition) throw new Error(message); }

async function main() {
    const suffix = crypto.randomBytes(4).toString('hex');
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Race Test',$1) RETURNING id`, [`race-${suffix}@example.invalid`])).rows[0];
    const other = (await query(`INSERT INTO customers(display_name,email) VALUES('Other',$1) RETURNING id`, [`race-other-${suffix}@example.invalid`])).rows[0];

    const created = await intents.createIntent({ scope: 'customer', customerId: customer.id, provider: 'paypal', checkoutMode: 'payment', commercialSnapshot: {} });
    const nonce = created.nonce;
    await intents.attachProviderCheckout(created.id, `PAYPAL-ORDER-${suffix}`);

    // A duplicate webhook can arrive while the original signed event is still
    // activating the entitlement. The duplicate must be acknowledged without
    // marking the checkout complete until the durable payment-event row says
    // the first processor actually finished successfully.
    const eventId = `PAYPAL-EVENT-${suffix}`;
    const eventRow = await lifecycle.beginPaymentEvent({ provider: 'paypal', eventId, eventType: 'PAYMENT.SALE.COMPLETED', payload: { id: eventId } });
    expect(eventRow, 'first payment-event delivery must acquire the processing lease');
    const duplicateLease = await lifecycle.beginPaymentEvent({ provider: 'paypal', eventId, eventType: 'PAYMENT.SALE.COMPLETED', payload: { id: eventId } });
    expect(duplicateLease === null, 'concurrent duplicate payment event must not acquire a second lease');
    expect(await lifecycle.paymentEventProcessed('paypal', eventId) === false, 'leased but unfinished payment event must not look processed');
    expect(await webhooks.checkoutFinalizationReady('paypal', eventId, { duplicate: true }) === false, 'in-flight duplicate webhook must not finalize the checkout intent');
    expect(await lifecycle.finishPaymentEvent(eventRow) === true, 'successful payment event must release its lease and mark processed');
    expect(await lifecycle.paymentEventProcessed('paypal', eventId) === true, 'successfully finished event must expose durable processed state');
    expect(await webhooks.checkoutFinalizationReady('paypal', eventId, { duplicate: true }) === true, 'a later duplicate may repair checkout finalization after the original payment event succeeded');
    expect(await webhooks.checkoutFinalizationReady('paypal', `${eventId}-fresh`, { duplicate: false }) === true, 'the original successful delivery may finalize normally');

    const failedEventId = `${eventId}-failed`;
    const failedRow = await lifecycle.beginPaymentEvent({ provider: 'paypal', eventId: failedEventId, eventType: 'PAYMENT.SALE.COMPLETED', payload: { id: failedEventId } });
    expect(failedRow, 'failed-event fixture must acquire a lease');
    expect(await lifecycle.finishPaymentEvent(failedRow, new Error('fixture activation failure')) === true, 'failed event must release its lease');
    expect(await lifecycle.paymentEventProcessed('paypal', failedEventId) === false, 'failed payment processing must never authorize checkout finalization');

    // Simulate the provider webhook winning the normal completed race: it
    // completes the intent before the browser's own return request is processed.
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
