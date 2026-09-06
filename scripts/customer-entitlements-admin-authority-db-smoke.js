'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');

const suffix = crypto.randomBytes(5).toString('hex');
const created = { customers: [], plans: [] };

async function createCustomer(label) {
    const result = await query(
        'INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id',
        [`Entitlement authority ${label} ${suffix}`, `entitlement-authority-${label}-${suffix}@example.invalid`]
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
    `, [`entitlement-authority-${suffix}`, `Entitlement Authority ${suffix}`]);
    created.plans.push(result.rows[0].id);
    return result.rows[0].id;
}

async function createExpiredSubscription(customerId, planId) {
    const result = await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,billing_mode,
            starts_at,current_period_end,service_type_snapshot
        ) VALUES($1,$2,'cancelled','stripe','subscription',NOW()-INTERVAL '60 days',NOW()-INTERVAL '30 days','jellyfin')
        RETURNING id
    `, [customerId, planId]);
    return result.rows[0].id;
}

async function readView(customerId) {
    const result = await query('SELECT * FROM effective_customer_entitlements WHERE customer_id=$1', [customerId]);
    return result.rows[0] || null;
}

(async () => {
    const planId = await createPaidPlan();

    // Case 1: a cancelled/expired Jellyfin subscription is invisible to the
    // view by default - the pre-existing, unaffected baseline behavior.
    const baselineCustomer = await createCustomer('expired-no-admin');
    await createExpiredSubscription(baselineCustomer, planId);
    const baselineRow = await readView(baselineCustomer);
    assert.strictEqual(baselineRow, null, 'an expired subscription with no admin directive must remain invisible to effective_customer_entitlements');

    // Case 2: the same expired subscription, but the customer holds an
    // active admin_present directive for jellyfin. The view must now surface
    // the row as unblocked with infinite access_expires_at - this is the bug
    // this migration fixes (previously the WHERE clause excluded the row
    // entirely, so admin-granted goodwill access was invisible to every
    // direct consumer of this view: admin dashboards, customer-filters.js
    // segmentation, and affiliate-credits.js's overlap check).
    const presentCustomer = await createCustomer('expired-admin-present');
    await createExpiredSubscription(presentCustomer, planId);
    await query(`
        INSERT INTO customer_service_admin_control(customer_id,service,mode,reason)
        VALUES($1,'jellyfin','admin_present','DB smoke: goodwill access')
    `, [presentCustomer]);
    const presentRow = await readView(presentCustomer);
    assert(presentRow, 'admin_present must make an otherwise-expired Jellyfin subscription visible to effective_customer_entitlements');
    assert.strictEqual(presentRow.blocked, false, 'admin_present must not be reported as blocked');
    assert(presentRow.access_expires_at > new Date(Date.now() + 365 * 24 * 60 * 60 * 1000), 'admin_present must extend access_expires_at effectively to infinity');

    // Case 3: an otherwise-live subscription, but the customer holds an
    // active admin_removed directive for jellyfin. The view must report the
    // row as blocked=TRUE despite the subscription being commercially valid,
    // matching how automatic reconciliation (subscription-state.js) already
    // treats admin_removed as absolute.
    const removedCustomer = await createCustomer('live-admin-removed');
    const liveSubResult = await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,billing_mode,
            starts_at,current_period_end,service_type_snapshot
        ) VALUES($1,$2,'active','stripe','subscription',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days','jellyfin')
        RETURNING id
    `, [removedCustomer, planId]);
    assert(liveSubResult.rows[0].id, 'setup: live subscription must be created');
    await query(`
        INSERT INTO customer_service_admin_control(customer_id,service,mode,reason)
        VALUES($1,'jellyfin','admin_removed','DB smoke: forced removal')
    `, [removedCustomer]);
    const removedRow = await readView(removedCustomer);
    assert(removedRow, 'a live subscription must still surface a row even when admin_removed forces it blocked');
    assert.strictEqual(removedRow.blocked, true, 'admin_removed must force blocked=TRUE even for an otherwise-live subscription');

    console.log('customer entitlements admin authority DB smoke: ok');
})().finally(async () => {
    for (const customerId of created.customers.reverse()) {
        await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    }
    for (const createdPlanId of created.plans.reverse()) {
        await query('DELETE FROM plans WHERE id=$1', [createdPlanId]).catch(() => {});
    }
    await getPool().end();
}).catch((error) => {
    console.error('customer entitlements admin authority DB smoke failed:', error);
    process.exit(1);
});
