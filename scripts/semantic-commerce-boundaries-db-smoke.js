'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const intents = require('../src/payments/checkout-intents');
const discounts = require('../src/payments/discounts');

const suffix = crypto.randomBytes(6).toString('hex');
function unique(label) { return `${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`; }

async function customer(label) {
    return (await query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *',
        [label, `${unique(label)}@example.invalid`]
    )).rows[0];
}

async function plan(label) {
    return (await query(`
        INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,capacity_limit,visible,active,streams,server_class)
        VALUES($1,$2,'jellyfin','direct','month',30,1000,'GBP',100,TRUE,TRUE,1,'premium')
        RETURNING *
    `, [unique(label), label])).rows[0];
}

function snapshotFor(p, overrides = {}) {
    return {
        kind: 'direct_plan',
        planId: p.id,
        planCode: p.code,
        planName: p.name,
        priceMinor: 1000,
        currency: 'GBP',
        billingInterval: 'month',
        durationDays: 30,
        streams: 1,
        provider: 'stripe',
        checkoutMode: 'payment',
        discountedMinor: 1000,
        ...overrides,
    };
}

async function restrictedDiscountCannotCrossCheckoutPlan() {
    const owner = await customer('discount-plan-binding');
    const planA = await plan('Restricted plan A');
    const planB = await plan('Target plan B');
    const code = unique('ONLYA').toUpperCase();

    await query(`
        INSERT INTO discount_codes(code,discount_type,percent_off,plan_codes,max_redemptions,per_customer_limit,active)
        VALUES($1,'percent',25,$2::text[],10,10,TRUE)
    `, [code, [planA.code]]);

    // Deliberately forge the caller-facing commercial labels while keeping the
    // authoritative checkout intent bound to Plan B. The DB boundary must use
    // billing_checkout_intents.plan_id -> plans.code, not caller planCode.
    const badIntent = await intents.createIntent({
        scope: 'customer',
        customerId: owner.id,
        planId: planB.id,
        provider: 'stripe',
        checkoutMode: 'payment',
        commercialSnapshot: snapshotFor(planB, { planId: planA.id, planCode: planA.code }),
    });

    let rejected = null;
    try {
        await discounts.reserveForIntent({
            code,
            planCode: planA.code,
            customerId: owner.id,
            checkoutIntentId: badIntent.id,
            baseMinor: 1000,
            currency: 'GBP',
            ttlMinutes: 30,
        });
    } catch (error) {
        rejected = error;
    }
    assert(rejected, 'A Plan-A-only discount was accepted against a Plan-B checkout intent');
    assert(
        /Discount reservation plan does not match checkout intent/.test(String(rejected.message)),
        `Unexpected cross-plan rejection: ${rejected.message}`
    );
    const badReservations = await query(
        'SELECT id FROM discount_checkout_reservations WHERE checkout_intent_id=$1',
        [badIntent.id]
    );
    assert.strictEqual(badReservations.rowCount, 0, 'Rejected cross-plan checkout left a discount reservation behind');
    await intents.consume({ intentId: badIntent.id, nonce: badIntent.nonce, state: 'failed', scope: 'customer', provider: 'stripe', ownerId: owner.id });

    const goodIntent = await intents.createIntent({
        scope: 'customer',
        customerId: owner.id,
        planId: planA.id,
        provider: 'stripe',
        checkoutMode: 'payment',
        commercialSnapshot: snapshotFor(planA),
    });
    const good = await discounts.reserveForIntent({
        code,
        planCode: planA.code,
        customerId: owner.id,
        checkoutIntentId: goodIntent.id,
        baseMinor: 1000,
        currency: 'GBP',
        ttlMinutes: 30,
    });
    assert(good?.reservation?.id, 'A correctly bound restricted discount was rejected');
    assert.strictEqual(Number(good.reservation.amount_applied_minor), 250);
}

async function main() {
    await restrictedDiscountCannotCrossCheckoutPlan();
    console.log('semantic commerce boundary DB smoke: restricted discounts cannot cross checkout-plan identity');
}

main().then(() => getPool().end()).catch(async error => {
    console.error(error.stack || error);
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});
