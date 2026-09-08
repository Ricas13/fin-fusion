'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const control = require('../src/jellyfin/reconciliation-control');

const suffix = crypto.randomBytes(5).toString('hex');
let customerId = null;
let planId = null;

async function provisioningState() {
    const result = await query(`
        SELECT status,reconcile_requested_at,last_attempt_at,next_attempt_at,
               (next_attempt_at IS NULL OR next_attempt_at<=NOW()) AS due
        FROM customer_provisioning_state
        WHERE customer_id=$1
    `, [customerId]);
    return result.rows[0] || null;
}

(async () => {
    const customer = await query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
        [`Wakeup ${suffix}`, `wakeup-${suffix}@example.invalid`]
    );
    customerId = customer.rows[0].id;

    const plan = await query(`
        INSERT INTO plans(
            code,name,service_type,audience,billing_interval,duration_days,
            price_minor,currency,capacity_limit,visible,active,streams,server_class
        ) VALUES($1,$2,'jellyfin','direct','month',30,999,'GBP',1000,TRUE,TRUE,1,'premium')
        RETURNING id
    `, [`wakeup-${suffix}`, `Wakeup ${suffix}`]);
    planId = plan.rows[0].id;

    const subscription = await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,provider_subscription_id,billing_mode,
            starts_at,current_period_end,service_type_snapshot
        ) VALUES($1,$2,'active','stripe',$3,'subscription',NOW()-INTERVAL '1 day',NOW()+INTERVAL '29 days','jellyfin')
        RETURNING id
    `, [customerId, planId, `sub_wakeup_${suffix}`]);
    const subscriptionId = subscription.rows[0].id;

    let state = await provisioningState();
    assert(state, 'subscription mutation must create customer provisioning state');
    assert.strictEqual(state.status, 'pending', 'subscription creation must queue reconciliation');
    assert(state.reconcile_requested_at, 'queued reconciliation must retain a durable request timestamp');
    assert.strictEqual(state.due, true, 'queued reconciliation must be immediately due');

    await control.markCustomerRunning(customerId, { subscription_id: subscriptionId, plan_id: planId });
    state = await provisioningState();
    assert.strictEqual(state.status, 'running', 'test setup must enter running state');
    assert.strictEqual(state.reconcile_requested_at, null, 'starting a run must consume older wakeups');

    // This is the race that matters: entitlement truth changes after the run
    // started. The trigger must record the newer request without clobbering the
    // running state, and completion must put the customer back into pending.
    await query('UPDATE subscriptions SET service_extension_days=1 WHERE id=$1', [subscriptionId]);
    state = await provisioningState();
    assert.strictEqual(state.status, 'running', 'an in-flight entitlement mutation must not corrupt running state');
    assert(state.reconcile_requested_at, 'an in-flight entitlement mutation must record a newer reconciliation request');
    assert(new Date(state.reconcile_requested_at) > new Date(state.last_attempt_at), 'the newer request must be distinguishable from the run start');

    await control.markCustomerHealthy(customerId, { subscriptionId, planId, result: { test: true } });
    state = await provisioningState();
    assert.strictEqual(state.status, 'pending', 'completion must requeue a mutation that arrived during the run');
    assert.strictEqual(state.due, true, 'the requeued customer must be immediately due');

    await control.markCustomerRunning(customerId, { subscription_id: subscriptionId, plan_id: planId });
    await control.markCustomerHealthy(customerId, { subscriptionId, planId, result: { test: true } });
    state = await provisioningState();
    assert.strictEqual(state.status, 'healthy', 'a run with no newer entitlement mutation may converge to healthy');
    assert.strictEqual(state.reconcile_requested_at, null, 'a clean reconciliation run must leave no unconsumed wakeup');

    // Access holds are entitlement authority too. Adding one must wake a
    // previously healthy customer even if the caller forgets to reconcile.
    await query(`
        INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason)
        VALUES($1,'test_hold',$2,'release-integrity wakeup smoke')
    `, [customerId, `wakeup-${suffix}`]);
    state = await provisioningState();
    assert.strictEqual(state.status, 'pending', 'access-hold insertion must queue reconciliation');
    assert.strictEqual(state.due, true, 'access-hold reconciliation must be immediately due');

    console.log('entitlement reconciliation wakeup DB smoke: ok');
})().finally(async () => {
    if (customerId) await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    if (planId) await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
    await getPool().end();
}).catch(error => {
    console.error('entitlement reconciliation wakeup DB smoke failed:', error);
    process.exit(1);
});
