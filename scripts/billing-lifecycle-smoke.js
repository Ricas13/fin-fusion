'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const billing = require('../src/payments/billing-control');

async function customer(name, email) {
    return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`, [name, email])).rows[0];
}

async function subscription({ customerId, planId, source, providerId, status = 'active', days = 30, billingMode = 'subscription' }) {
    return (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id)
        VALUES($1,$2,$3,$4,$7,NOW(),NOW()+($6::int * INTERVAL '1 day'),$5)
        RETURNING *
    `, [customerId, planId, status, source, providerId, days, billingMode])).rows[0];
}

async function activeDelinquencyHolds(customerId) {
    return (await query(`
        SELECT hold_type,source_key,reason
        FROM customer_access_holds
        WHERE customer_id=$1 AND hold_type='payment_delinquency' AND released_at IS NULL
        ORDER BY created_at,id
    `, [customerId])).rows;
}

(async () => {
    const plan = (await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
        VALUES('billing-control-test','Billing Control Test','direct','month',30,600,'USD',3,'premium',TRUE,TRUE)
        RETURNING id
    `)).rows[0];
    const stripeCustomer = await customer('Stripe Alice', 'stripe@example.test');
    const paypalCustomer = await customer('PayPal Bob', 'paypal@example.test');
    const oneTimeCustomer = await customer('One Time Carol', 'one@example.test');
    const failureCustomer = await customer('Failure Dan', 'failure@example.test');

    const stripeSub = await subscription({ customerId: stripeCustomer.id, planId: plan.id, source: 'stripe', providerId: 'sub_test_123', days: 5 });
    const paypalSub = await subscription({ customerId: paypalCustomer.id, planId: plan.id, source: 'paypal', providerId: 'I-PAYPAL123', days: 20 });
    const oneTime = await subscription({ customerId: oneTimeCustomer.id, planId: plan.id, source: 'stripe', providerId: 'pi_onetime123', days: 30, billingMode: 'payment' });
    const failureSub = await subscription({ customerId: failureCustomer.id, planId: plan.id, source: 'stripe', providerId: 'sub_failure123', days: 12 });

    const futureStripe = new Date(Date.now() + 10 * 86400000);
    const futurePayPal = new Date(Date.now() + 25 * 86400000);
    let stripeCancel = false;
    let stripeStatus = 'past_due';
    const stripeAdapter = {
        async fetchRemote(row) {
            if (String(row.id) === String(failureSub.id)) throw new Error('simulated Stripe outage');
            return { status: stripeStatus, periodEnd: futureStripe, cancelAtPeriodEnd: stripeCancel };
        },
        async stopRenewal() { stripeCancel = true; },
        async resumeRenewal() { stripeCancel = false; }
    };
    let paypalCancelled = false;
    const paypalAdapter = {
        async fetchRemote() {
            return paypalCancelled
                ? { status: 'active', remoteStatus: 'CANCELLED', periodEnd: futurePayPal, cancelAtPeriodEnd: true }
                : { status: 'ACTIVE', remoteStatus: 'ACTIVE', periodEnd: futurePayPal, cancelAtPeriodEnd: false };
        },
        async stopRenewal() { paypalCancelled = true; },
        async resumeRenewal() { throw new Error('not supported'); }
    };

    const first = await billing.syncDue({ all: true, adapters: { stripe: stripeAdapter, paypal: paypalAdapter } });
    assert.strictEqual(first.total, 3, 'only billing_mode=subscription rows should be synchronized');
    assert.strictEqual(first.succeeded, 2);
    assert.strictEqual(first.failed, 1);
    assert(!first.results.some(row => String(row.subscriptionId) === String(oneTime.id)), 'one-time payment was incorrectly treated as recurring');

    const stripeAfter = (await query(`SELECT status,current_period_end,cancel_at_period_end FROM subscriptions WHERE id=$1`, [stripeSub.id])).rows[0];
    assert.strictEqual(stripeAfter.status, 'past_due');
    assert.strictEqual(stripeAfter.cancel_at_period_end, false);
    assert(Math.abs(new Date(stripeAfter.current_period_end).getTime() - futureStripe.getTime()) < 2000);
    let stripeHolds = await activeDelinquencyHolds(stripeCustomer.id);
    assert.strictEqual(stripeHolds.length, 1, 'past-due recurring payment must create an access hold');
    assert.strictEqual(stripeHolds[0].source_key, 'stripe:sub_test_123');

    stripeStatus = 'active';
    const recovered = await billing.syncSubscription(stripeSub.id, { adapter: stripeAdapter });
    assert.strictEqual(recovered.ok, true, 'provider recovery sync should succeed');
    assert.strictEqual((await query(`SELECT status FROM subscriptions WHERE id=$1`, [stripeSub.id])).rows[0].status, 'active');
    stripeHolds = await activeDelinquencyHolds(stripeCustomer.id);
    assert.strictEqual(stripeHolds.length, 0, 'successful payment recovery must release the delinquency hold');

    stripeStatus = 'past_due';
    const relapsed = await billing.syncSubscription(stripeSub.id, { adapter: stripeAdapter });
    assert.strictEqual(relapsed.ok, true);
    assert.strictEqual((await activeDelinquencyHolds(stripeCustomer.id)).length, 1, 'a later failed renewal must suspend access again');

    const paypalAfter = (await query(`SELECT status,current_period_end,cancel_at_period_end FROM subscriptions WHERE id=$1`, [paypalSub.id])).rows[0];
    assert.strictEqual(paypalAfter.status, 'active');
    assert.strictEqual(paypalAfter.cancel_at_period_end, false);
    assert(Math.abs(new Date(paypalAfter.current_period_end).getTime() - futurePayPal.getTime()) < 2000);

    const failureAfter = (await query(`SELECT status,current_period_end FROM subscriptions WHERE id=$1`, [failureSub.id])).rows[0];
    assert.strictEqual(failureAfter.status, 'active', 'provider network failure must not change local entitlement state');
    assert.strictEqual((await activeDelinquencyHolds(failureCustomer.id)).length, 0, 'provider outage alone must not suspend a paying customer');
    const failureSync = (await query(`SELECT last_error,consecutive_failures,next_attempt_at,last_success_at FROM subscription_provider_sync WHERE subscription_id=$1`, [failureSub.id])).rows[0];
    assert(/simulated Stripe outage/.test(failureSync.last_error));
    assert.strictEqual(Number(failureSync.consecutive_failures), 1);
    assert(new Date(failureSync.next_attempt_at) > new Date());
    assert.strictEqual(failureSync.last_success_at, null);

    const stripeSync = (await query(`SELECT remote_status,last_success_at,last_error,next_attempt_at FROM subscription_provider_sync WHERE subscription_id=$1`, [stripeSub.id])).rows[0];
    assert.strictEqual(stripeSync.remote_status, 'past_due');
    assert(stripeSync.last_success_at);
    assert.strictEqual(stripeSync.last_error, null);
    assert(new Date(stripeSync.next_attempt_at).getTime() - new Date(stripeSync.last_success_at).getTime() > 5 * 60 * 60 * 1000);

    await billing.setRenewal(stripeSub.id, false, null, { adapter: stripeAdapter });
    assert.strictEqual((await query(`SELECT cancel_at_period_end FROM subscriptions WHERE id=$1`, [stripeSub.id])).rows[0].cancel_at_period_end, true);
    await billing.setRenewal(stripeSub.id, true, null, { adapter: stripeAdapter });
    assert.strictEqual((await query(`SELECT cancel_at_period_end FROM subscriptions WHERE id=$1`, [stripeSub.id])).rows[0].cancel_at_period_end, false);

    await billing.setRenewal(paypalSub.id, false, null, { adapter: paypalAdapter });
    const paypalCancelledLocal = (await query(`SELECT status,cancel_at_period_end,current_period_end FROM subscriptions WHERE id=$1`, [paypalSub.id])).rows[0];
    assert.strictEqual(paypalCancelledLocal.status, 'active', 'PayPal cancellation should retain already-paid access until period end');
    assert.strictEqual(paypalCancelledLocal.cancel_at_period_end, true);
    assert(new Date(paypalCancelledLocal.current_period_end) > new Date());

    await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processing_error)
        VALUES('stripe','evt_failed_test','invoice.payment_failed','{}'::jsonb,'simulated webhook processing failure')
    `);
    const dashboard = await billing.dashboardData();
    assert.strictEqual(dashboard.stats.recurring, 3);
    assert(dashboard.stats.pastDue >= 1);
    assert.strictEqual(dashboard.stats.syncProblems, 1);
    assert.strictEqual(dashboard.events.length, 1);

    console.log('billing lifecycle smoke: ok');
})().catch(async error => {
    console.error(error);
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});