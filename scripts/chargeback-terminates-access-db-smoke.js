'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const incidents = require('../src/payments/incidents');

const suffix = crypto.randomBytes(5).toString('hex');
const created = { customers: [], plans: [] };

async function createCustomer(label) {
    const result = await query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
        [`Chargeback ${label} ${suffix}`, `chargeback-${label}-${suffix}@example.invalid`]
    );
    created.customers.push(result.rows[0].id);
    return result.rows[0].id;
}

async function createPaidPlan() {
    const result = await query(`
        INSERT INTO plans(
            code,name,service_type,audience,billing_interval,duration_days,
            price_minor,currency,capacity_limit,visible,active,streams,server_class
        ) VALUES($1,$2,'jellyfin','direct','month',30,999,'GBP',1000,TRUE,TRUE,1,'premium')
        RETURNING id
    `, [`chargeback-${suffix}`, `Chargeback ${suffix}`]);
    created.plans.push(result.rows[0].id);
    return result.rows[0].id;
}

async function createActiveSubscription(customerId, planId, providerSubscriptionId) {
    const result = await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,provider_subscription_id,billing_mode,
            starts_at,current_period_end,service_type_snapshot
        ) VALUES($1,$2,'active','stripe',$3,'subscription',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days','jellyfin')
        RETURNING id
    `, [customerId, planId, providerSubscriptionId]);
    return result.rows[0].id;
}

async function subscriptionState(subscriptionId) {
    const result = await query('SELECT status,cancel_at_period_end,service_extension_days,current_period_end FROM subscriptions WHERE id=$1', [subscriptionId]);
    return result.rows[0];
}

(async () => {
    const planId = await createPaidPlan();

    // Case 1: a lost Stripe chargeback (kind='chargeback', status='lost') must
    // terminate the matched local subscription exactly like a confirmed full
    // refund does - this is the fix under test. Before this fix, only
    // kind='refund'+fullRefund triggered terminateForRefund, so a merchant
    // who forcibly lost the customer's money via a chargeback kept the
    // customer fully provisioned indefinitely.
    const lostCustomer = await createCustomer('lost-stripe');
    const lostProviderSubId = `sub_lost_${suffix}`;
    const lostSubscriptionId = await createActiveSubscription(lostCustomer, planId, lostProviderSubId);
    const before = await subscriptionState(lostSubscriptionId);
    assert.strictEqual(before.status, 'active', 'setup: subscription must start active');

    await incidents.record({
        provider: 'stripe',
        eventId: `evt_chargeback_lost_${suffix}`,
        caseId: `dp_lost_${suffix}`,
        kind: 'chargeback',
        status: 'lost',
        identity: { scope: 'direct', customerId: lostCustomer },
        providerSubscriptionId: lostProviderSubId
    });

    const after = await subscriptionState(lostSubscriptionId);
    assert.strictEqual(after.status, 'cancelled', 'a lost chargeback must terminate the matched subscription');
    assert.strictEqual(after.cancel_at_period_end, true, 'a lost chargeback must mark the subscription as ended');
    assert.strictEqual(after.service_extension_days, 0, 'a lost chargeback must clear any service extension');
    assert(after.current_period_end <= new Date(Date.now() + 1000), 'a lost chargeback must pull the access-expiry forward to now');

    // Case 2: an OPEN dispute (not yet lost) must NOT terminate access - the
    // outcome isn't final, and premature termination would punish a merchant
    // who is going to win the dispute.
    const openCustomer = await createCustomer('open-dispute');
    const openProviderSubId = `sub_open_${suffix}`;
    const openSubscriptionId = await createActiveSubscription(openCustomer, planId, openProviderSubId);

    await incidents.record({
        provider: 'stripe',
        eventId: `evt_dispute_open_${suffix}`,
        caseId: `dp_open_${suffix}`,
        kind: 'dispute',
        status: 'open',
        identity: { scope: 'direct', customerId: openCustomer },
        providerSubscriptionId: openProviderSubId
    });

    const stillActive = await subscriptionState(openSubscriptionId);
    assert.strictEqual(stillActive.status, 'active', 'an open (not yet lost) dispute must not terminate access');

    // Case 3: a WON dispute must not terminate access either.
    const wonCustomer = await createCustomer('won-dispute');
    const wonProviderSubId = `sub_won_${suffix}`;
    const wonSubscriptionId = await createActiveSubscription(wonCustomer, planId, wonProviderSubId);

    await incidents.record({
        provider: 'stripe',
        eventId: `evt_dispute_won_${suffix}`,
        caseId: `dp_won_${suffix}`,
        kind: 'dispute',
        status: 'won',
        identity: { scope: 'direct', customerId: wonCustomer },
        providerSubscriptionId: wonProviderSubId
    });

    const wonState = await subscriptionState(wonSubscriptionId);
    assert.strictEqual(wonState.status, 'active', 'a merchant-won dispute must not terminate access');

    console.log('chargeback terminates access DB smoke: ok');
})().finally(async () => {
    for (const customerId of created.customers.reverse()) {
        await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    }
    for (const createdPlanId of created.plans.reverse()) {
        await query('DELETE FROM plans WHERE id=$1', [createdPlanId]).catch(() => {});
    }
    await getPool().end();
}).catch((error) => {
    console.error('chargeback terminates access DB smoke failed:', error);
    process.exit(1);
});
