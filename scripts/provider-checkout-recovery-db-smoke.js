'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const recovery = require('../src/payments/provider-checkout-recovery');

const suffix = crypto.randomBytes(6).toString('hex');
const createdCustomers = [];
const createdPlans = [];
const createdIntents = [];

function unique(label) { return `${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`; }

async function customer(label) {
    const row = (await query(
        `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`,
        [label, `${unique(label)}@example.invalid`]
    )).rows[0];
    createdCustomers.push(row.id);
    return row;
}

async function plan(label) {
    const row = (await query(`
        INSERT INTO plans(
            code,name,service_type,audience,billing_interval,duration_days,
            price_minor,currency,capacity_limit,visible,active,streams,server_class
        ) VALUES($1,$2,'jellyfin','direct','month',30,1000,'GBP',100,TRUE,TRUE,1,'premium')
        RETURNING *
    `, [unique(label), label])).rows[0];
    createdPlans.push(row.id);
    return row;
}

function snapshotFor(p, provider, providerMappingId, checkoutMode = 'subscription') {
    return {
        kind: 'direct_plan',
        planId: p.id,
        planPriceId: null,
        planCode: p.code,
        planName: p.name,
        priceMinor: Number(p.price_minor),
        discountedMinor: Number(p.price_minor),
        currency: 'GBP',
        billingInterval: 'month',
        durationDays: 30,
        streams: 1,
        stremioHouseholdNetworkLimit: 1,
        provider,
        checkoutMode,
        providerMappingId,
        providerMappingRecordId: null
    };
}

async function attachedIntent(label, provider, providerCheckoutId, providerMappingId, checkoutMode = 'subscription') {
    const owner = await customer(`${label} customer`);
    const p = await plan(`${label} plan`);
    const created = await intents.createIntent({
        scope: 'customer',
        customerId: owner.id,
        planId: p.id,
        provider,
        checkoutMode,
        commercialSnapshot: snapshotFor(p, provider, providerMappingId, checkoutMode)
    });
    await intents.attachProviderCheckout(created.id, providerCheckoutId);
    createdIntents.push(created.id);
    return { ...created, owner, plan: p, providerCheckoutId };
}

async function stateOf(id) {
    return (await query(`SELECT state,provider_terminal_at FROM billing_checkout_intents WHERE id=$1`, [id])).rows[0];
}

async function cleanup() {
    if (createdIntents.length) await query(`DELETE FROM billing_checkout_intents WHERE id=ANY($1::uuid[])`, [createdIntents]).catch(() => {});
    if (createdPlans.length) await query(`DELETE FROM plans WHERE id=ANY($1::uuid[])`, [createdPlans]).catch(() => {});
    if (createdCustomers.length) await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [createdCustomers]).catch(() => {});
}

function missingPayPalError(status = 404, message = 'The specified resource does not exist.') {
    const error = new Error(message);
    error.provider = 'paypal';
    error.code = 'http_error';
    error.status = status;
    error.retryable = false;
    return error;
}

async function main() {
    const stripeOk = await attachedIntent('recovery stripe ok', 'stripe', `cs_test_${unique('ok')}`, `price_${unique('ok')}`);
    const stripeFail = await attachedIntent('recovery stripe fail', 'stripe', `cs_test_${unique('fail')}`, `price_${unique('fail')}`);
    const stripePayment = await attachedIntent('recovery stripe payment', 'stripe', `cs_test_${unique('payment')}`, null, 'payment');
    const paypalActive = await attachedIntent('recovery paypal active', 'paypal', `I-${unique('active')}`, `P-${unique('active')}`);
    const paypalPending = await attachedIntent('recovery paypal pending', 'paypal', `I-${unique('pending')}`, `P-${unique('pending')}`);

    const first = await recovery.run({
        limit: 20,
        checkoutIntentIds: createdIntents,
        handlers: {
            async stripe(row) {
                if (row.id === stripeFail.id) throw new Error('synthetic provider timeout');
                await intents.completeVerifiedProvider('stripe', row.provider_checkout_id, 'completed');
                return { completed: true, waiting: false, status: 'completed' };
            },
            async paypalStatus(row) {
                if (row.id === paypalPending.id) return { row: null, providerStatus: 'APPROVAL_PENDING' };
                return { row: null, providerStatus: 'ACTIVE' };
            },
            async paypalActivate(row) {
                await intents.completeVerifiedProvider('paypal', row.provider_checkout_id, 'completed');
                return { id: `subscription-${row.id}` };
            },
            async markTerminal(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled');
            },
            async markCompleted(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'completed');
            }
        }
    });

    assert.strictEqual(first.total, 5, 'first recovery pass must see unfinished recurring checkouts plus Stripe one-time checkouts');
    assert.strictEqual(first.processed, 5, 'one provider failure must not abort the rest of the batch');
    assert.strictEqual(first.recovered, 3, 'Stripe subscription/payment and PayPal ACTIVE checkouts must recover');
    assert.strictEqual(first.waiting, 1, 'PayPal approval-pending checkout must remain waiting');
    assert.strictEqual(first.failed, 1, 'provider failure must remain retryable and operator-visible');
    assert.strictEqual((await stateOf(stripeOk.id)).state, 'completed');
    assert.strictEqual((await stateOf(stripePayment.id)).state, 'completed', 'paid Stripe one-time Checkout must enter the same verified recovery path');
    assert.strictEqual((await stateOf(paypalActive.id)).state, 'completed');
    assert.strictEqual((await stateOf(stripeFail.id)).state, 'open');
    assert.strictEqual((await stateOf(paypalPending.id)).state, 'open', 'approval-pending PayPal must never be converted into access');

    const second = await recovery.run({
        limit: 20,
        checkoutIntentIds: createdIntents,
        handlers: {
            async stripe(row) {
                await intents.completeVerifiedProvider('stripe', row.provider_checkout_id, 'completed');
                return { completed: true, waiting: false, status: 'completed' };
            },
            async paypalStatus() {
                return { row: null, providerStatus: 'EXPIRED' };
            },
            async paypalActivate() {
                throw new Error('terminal PayPal checkout must not activate');
            },
            async markTerminal(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled');
            },
            async markCompleted(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'completed');
            }
        }
    });

    assert.strictEqual(second.total, 2, 'completed recoveries must disappear from the retry set');
    assert.strictEqual(second.recovered, 1, 'failed Stripe checkout must be retryable on the next pass');
    assert.strictEqual(second.terminal, 1, 'provider-terminal PayPal checkout must close without access');
    assert.strictEqual(second.failed, 0);
    assert.strictEqual((await stateOf(stripeFail.id)).state, 'completed');
    const pendingTerminal = await stateOf(paypalPending.id);
    assert.strictEqual(pendingTerminal.state, 'cancelled');
    assert(pendingTerminal.provider_terminal_at, 'verified provider-terminal checkout must record terminal proof');

    const third = await recovery.run({ limit: 20, checkoutIntentIds: createdIntents, handlers: {} });
    assert.strictEqual(third.total, 0, 'settled/terminal checkouts must not be polled forever');

    const paypalMissing = await attachedIntent(
        'recovery paypal missing',
        'paypal',
        `I-${unique('missing')}`,
        `P-${unique('missing')}`
    );
    await query(`
        UPDATE billing_checkout_intents
        SET state='expired',expires_at=NOW()-INTERVAL '1 minute',updated_at=NOW()
        WHERE id=$1
    `, [paypalMissing.id]);

    const missingResult = await recovery.run({
        limit: 20,
        checkoutIntentIds: [paypalMissing.id],
        handlers: {
            async paypalStatus() {
                throw missingPayPalError();
            },
            async markTerminal(row) {
                return intents.completeVerifiedProvider(row.provider, row.provider_checkout_id, 'cancelled');
            }
        }
    });
    assert.strictEqual(missingResult.total, 1);
    assert.strictEqual(missingResult.terminal, 1, 'expired PayPal checkout missing at the provider must converge terminally');
    assert.strictEqual(missingResult.failed, 0);
    const missingTerminal = await stateOf(paypalMissing.id);
    assert.strictEqual(missingTerminal.state, 'expired', 'provider proof must not rewrite the historical local expiry state');
    assert(missingTerminal.provider_terminal_at, 'provider-not-found must record terminal proof');
    assert.strictEqual((await recovery.candidates({ checkoutIntentIds: [paypalMissing.id] })).length, 0,
        'provider-terminal expired PayPal checkout must leave the retry set');

    const paypalOpenMissing = await attachedIntent(
        'recovery paypal open missing',
        'paypal',
        `I-${unique('open-missing')}`,
        `P-${unique('open-missing')}`
    );
    const openMissingResult = await recovery.run({
        limit: 20,
        checkoutIntentIds: [paypalOpenMissing.id],
        handlers: {
            async paypalStatus() {
                throw missingPayPalError();
            }
        }
    });
    assert.strictEqual(openMissingResult.failed, 1, 'open PayPal 404 must remain operator-visible');
    assert.strictEqual((await stateOf(paypalOpenMissing.id)).state, 'open');

    assert.strictEqual(recovery.paypalResourceNotFound(missingPayPalError(404)), true);
    assert.strictEqual(recovery.paypalResourceNotFound(missingPayPalError(422)), true);
    assert.strictEqual(recovery.paypalResourceNotFound(missingPayPalError(422, 'Validation failed.')), false,
        'generic PayPal 422 must not be mistaken for resource absence');

    console.log('provider checkout recovery DB smoke: retry isolation, pending safety and terminal convergence ok');
}

main().catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
}).finally(async () => {
    await cleanup();
    await getPool().end();
});
