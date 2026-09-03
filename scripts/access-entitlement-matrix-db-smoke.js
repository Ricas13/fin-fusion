'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const accessHolds = require('../src/entitlements/access-holds');
const subscriptionState = require('../src/entitlements/subscription-state');

const suffix = crypto.randomBytes(5).toString('hex');
const created = { customers: [], plans: [] };

async function createCustomer(label) {
    const result = await query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
        [`Access matrix ${label} ${suffix}`, `access-matrix-${label}-${suffix}@example.invalid`]
    );
    created.customers.push(result.rows[0].id);
    return result.rows[0].id;
}

async function createPaidPlan(label = 'paid') {
    const result = await query(`
        INSERT INTO plans(
            code,name,service_type,audience,billing_interval,duration_days,
            price_minor,currency,capacity_limit,visible,active,streams,server_class
        ) VALUES($1,$2,'jellyfin','direct','month',30,999,'GBP',1000,TRUE,TRUE,1,'premium')
        RETURNING id
    `, [`access-matrix-${label}-${suffix}`, `Access matrix ${label} ${suffix}`]);
    created.plans.push(result.rows[0].id);
    return result.rows[0].id;
}

async function freePlanId() {
    const result = await query(`
        SELECT id FROM plans
        WHERE is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE
        ORDER BY created_at,id LIMIT 1
    `);
    assert.strictEqual(result.rowCount, 1, 'clean install must contain the canonical Free tier plan');
    return result.rows[0].id;
}

async function createSubscription({
    customerId,
    planId,
    status = 'active',
    source = 'admin_grant',
    providerSubscriptionId = null,
    billingMode = 'manual',
    periodEndSql = "NOW()+INTERVAL '30 days'",
    extensionDays = 0
}) {
    const result = await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,provider_subscription_id,billing_mode,
            starts_at,current_period_end,service_extension_days,service_type_snapshot
        ) VALUES($1,$2,$3,$4,$5,$6,NOW()-INTERVAL '30 days',${periodEndSql},$7,'jellyfin')
        RETURNING id
    `, [customerId, planId, status, source, providerSubscriptionId, billingMode, extensionDays]);
    return result.rows[0].id;
}

async function functionBlocked(customerId, source, providerSubscriptionId = null) {
    const result = await query(
        'SELECT public.subscription_access_blocked($1,$2,$3) AS blocked',
        [customerId, source, providerSubscriptionId]
    );
    return Boolean(result.rows[0]?.blocked);
}

async function release(customerId, type, sourceKey = null) {
    await accessHolds.releaseHold({ customerId, type, sourceKey, resolutionReason: 'DB matrix cleanup' });
}

async function assertEffectiveStatusMatrix(planId) {
    const cases = [
        { label: 'active-live', status: 'active', periodEndSql: "NOW()+INTERVAL '30 days'", extensionDays: 0, expected: true },
        { label: 'trial-live', status: 'trialing', periodEndSql: "NOW()+INTERVAL '30 days'", extensionDays: 0, expected: true },
        { label: 'past-due-live', status: 'past_due', periodEndSql: "NOW()+INTERVAL '30 days'", extensionDays: 0, expected: true },
        { label: 'paused-live', status: 'paused', periodEndSql: "NOW()+INTERVAL '30 days'", extensionDays: 0, expected: true },
        { label: 'active-expired', status: 'active', periodEndSql: "NOW()-INTERVAL '2 days'", extensionDays: 0, expected: false },
        { label: 'cancelled-extension', status: 'cancelled', periodEndSql: "NOW()-INTERVAL '5 days'", extensionDays: 10, expected: true },
        { label: 'expired-extension', status: 'expired', periodEndSql: "NOW()-INTERVAL '5 days'", extensionDays: 10, expected: true },
        { label: 'expired-extension-ended', status: 'expired', periodEndSql: "NOW()-INTERVAL '20 days'", extensionDays: 10, expected: false }
    ];

    for (const item of cases) {
        const customerId = await createCustomer(item.label);
        await createSubscription({
            customerId,
            planId,
            status: item.status,
            periodEndSql: item.periodEndSql,
            extensionDays: item.extensionDays
        });
        const effective = await subscriptionState.effectiveSubscription(customerId, { includeBlocked: true });
        assert.strictEqual(
            Boolean(effective),
            item.expected,
            `${item.label}: effective Jellyfin entitlement lifetime semantics must remain stable`
        );
    }
}

async function assertHoldScopeMatrix(planId, canonicalFreePlanId) {
    const customerId = await createCustomer('hold-scope');
    const stripeId = `sub_matrix_${suffix}`;
    await createSubscription({
        customerId,
        planId,
        source: 'stripe',
        providerSubscriptionId: stripeId,
        billingMode: 'subscription'
    });

    assert.strictEqual(await functionBlocked(customerId, 'stripe', stripeId), false, 'baseline Stripe subscription must be unblocked');

    await accessHolds.addHold({
        customerId,
        type: 'payment_delinquency',
        sourceKey: 'stripe:sub_other',
        reason: 'Unrelated Stripe subscription delinquency'
    });
    assert.strictEqual(await functionBlocked(customerId, 'stripe', stripeId), false, 'delinquency for another Stripe subscription must not block this subscription');
    assert.strictEqual(await functionBlocked(customerId, 'paypal', `I-${suffix}`), false, 'Stripe delinquency must not block PayPal');
    await release(customerId, 'payment_delinquency', 'stripe:sub_other');

    await accessHolds.addHold({
        customerId,
        type: 'payment_delinquency',
        sourceKey: `stripe:${stripeId}`,
        reason: 'Matching Stripe delinquency'
    });
    assert.strictEqual(await functionBlocked(customerId, 'stripe', stripeId), true, 'matching Stripe delinquency must block only that provider subscription');
    assert.strictEqual(await functionBlocked(customerId, 'stripe', `sub_other_${suffix}`), false, 'matching Stripe delinquency must not spill into another Stripe subscription');
    const hiddenByPaymentHold = await subscriptionState.effectiveSubscription(customerId);
    assert.strictEqual(hiddenByPaymentHold, null, 'default entitlement resolution must hide a matching payment-blocked subscription');
    const visibleBlocked = await subscriptionState.effectiveSubscription(customerId, { includeBlocked: true });
    assert(visibleBlocked && visibleBlocked.blocked === true, 'includeBlocked must preserve commercial truth while exposing the blocker');
    await release(customerId, 'payment_delinquency', `stripe:${stripeId}`);

    const paypalKey = `paypal:I-${suffix}`;
    await accessHolds.addHold({
        customerId,
        type: 'payment_delinquency',
        sourceKey: paypalKey,
        reason: 'Matching PayPal delinquency'
    });
    assert.strictEqual(await functionBlocked(customerId, 'paypal', `I-${suffix}`), true, 'matching PayPal delinquency must block that PayPal subscription');
    assert.strictEqual(await functionBlocked(customerId, 'stripe', stripeId), false, 'PayPal delinquency must not block Stripe');
    await release(customerId, 'payment_delinquency', paypalKey);

    for (const type of ['admin_disabled', 'admin_suspended', 'admin_hold', 'legacy', 'security_review']) {
        const sourceKey = `matrix-${type}`;
        await accessHolds.addHold({ customerId, type, sourceKey, reason: `Global ${type} blocker` });
        assert.strictEqual(await functionBlocked(customerId, 'stripe', stripeId), true, `${type} must block paid Stripe access customer-wide`);
        assert.strictEqual(await functionBlocked(customerId, 'free_claim', null), true, `${type} must block Free access customer-wide`);
        assert.strictEqual(await functionBlocked(customerId, 'paypal', `I-${suffix}`), true, `${type} must block PayPal access customer-wide`);
        await release(customerId, type, sourceKey);
    }

    for (const type of ['inactivity_policy', 'jellyfin_cleanup']) {
        const sourceKey = type === 'inactivity_policy' ? `plan:${canonicalFreePlanId}` : `server:${suffix}`;
        await accessHolds.addHold({ customerId, type, sourceKey, reason: `${type} Free-lane blocker` });
        assert.strictEqual(await functionBlocked(customerId, 'free_claim', null), true, `${type} must block the Free lane`);
        assert.strictEqual(await functionBlocked(customerId, 'stripe', stripeId), false, `${type} must not block simultaneous paid Jellyfin access`);
        assert.strictEqual(await functionBlocked(customerId, 'paypal', `I-${suffix}`), false, `${type} must not block unrelated paid access`);
        await release(customerId, type, sourceKey);
    }
}

async function assertParallelFreeAndPaid(planId, canonicalFreePlanId) {
    const customerId = await createCustomer('parallel-free-paid');
    await createSubscription({ customerId, planId, source: 'admin_grant', billingMode: 'manual' });
    await createSubscription({
        customerId,
        planId: canonicalFreePlanId,
        source: 'free_claim',
        billingMode: 'manual',
        periodEndSql: "NOW()+INTERVAL '3000 days'"
    });

    await accessHolds.addHold({
        customerId,
        type: 'inactivity_policy',
        sourceKey: `plan:${canonicalFreePlanId}`,
        reason: 'Free lane inactivity matrix hold'
    });

    const paid = await subscriptionState.effectiveSubscription(customerId);
    assert(paid && String(paid.plan_id) === String(planId), 'Free inactivity hold must not hide a simultaneous paid Jellyfin entitlement');
    const freeBlocked = await subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true });
    assert(freeBlocked && freeBlocked.blocked === true, 'the same inactivity hold must still block the retained Free lane');
    const freeDefault = await subscriptionState.liveFreeJellyfinSubscription(customerId);
    assert.strictEqual(freeDefault, null, 'blocked Free lane must not resolve as usable access by default');
}

(async () => {
    const planId = await createPaidPlan();
    const canonicalFreePlanId = await freePlanId();
    try {
        await assertEffectiveStatusMatrix(planId);
        await assertHoldScopeMatrix(planId, canonicalFreePlanId);
        await assertParallelFreeAndPaid(planId, canonicalFreePlanId);
        console.log('access entitlement DB matrix smoke: ok');
    } finally {
        for (const customerId of created.customers.reverse()) {
            await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        }
        for (const createdPlanId of created.plans.reverse()) {
            await query('DELETE FROM plans WHERE id=$1', [createdPlanId]).catch(() => {});
        }
    }
})().finally(() => getPool().end()).catch(() => {
    console.error('access entitlement DB matrix smoke failed');
    process.exit(1);
});