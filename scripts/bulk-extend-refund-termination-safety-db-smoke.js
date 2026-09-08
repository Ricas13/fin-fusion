'use strict';

// DB-backed regression test: the admin bulk "Extend" action
// (src/platform/bulk-operations.js's extend_entitlement handler) must never
// resurrect access on a subscription that was terminated for a confirmed
// refund/chargeback (src/payments/subscription-termination.js's
// terminateForRefund -- "money confirmed lost = remove plan", see
// incidents.js). Its currentSubscription() helper falls back to the
// customer's most recent Jellyfin/bundle subscription row whenever there is
// no currently-live one, with no status filter; that fallback previously let
// extend_entitlement pick the exact refund-terminated row and add a positive
// service_extension_days back onto it, which subscription-state.js's live
// window treats as live again -- reopening access the platform had just,
// deliberately, permanently closed.
//
// An ordinary administrative "end Jellyfin plan" termination (terminateLocal)
// is intentionally NOT blocked here -- extending a customer whose plan an
// admin ended (as opposed to one refunded/charged back) is a legitimate,
// still-supported reactivation path, and this test also proves that path
// still works so the fix isn't overbroad.

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const bulkJobs = require('../src/platform/bulk-jobs');
const bulkWorker = require('../src/jellyfin/bulk-worker');
const subscriptionTermination = require('../src/payments/subscription-termination');
require('../src/platform/bulk-operations'); // registers extend_entitlement

const suffix = crypto.randomBytes(4).toString('hex');
const created = { customers: [], plans: [] };

async function makePlan(label) {
    const row = await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
        VALUES($1,$2,'direct','custom',30,999,'USD',1,'premium',TRUE,TRUE)
        RETURNING id
    `, [`bulk-extend-refund-safety-${label}-${suffix}`, `Bulk extend refund safety ${label}`]);
    created.plans.push(row.rows[0].id);
    return row.rows[0].id;
}

async function makeCustomer(label) {
    const row = await query(
        `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
        [`Bulk Extend Refund Safety ${label} ${suffix}`, `bulk-extend-refund-safety-${label}-${suffix}@example.invalid`]
    );
    created.customers.push(row.rows[0].id);
    return row.rows[0].id;
}

async function runExtend(customerId) {
    const job = await bulkJobs.createJob('extend_entitlement', { units: 1 });
    await bulkJobs.enqueueItems(job.job.id, [customerId]);
    await bulkWorker.processBatch();
    const item = (await query('SELECT status,last_error FROM background_job_items WHERE job_id=$1', [job.job.id])).rows[0];
    return item;
}

(async () => {
    // Case 1: a subscription terminated for a confirmed refund must stay
    // terminated -- extend_entitlement must fail closed, not resurrect it.
    const refundPlanId = await makePlan('refunded');
    const refundCustomerId = await makeCustomer('refunded');
    const refundSub = (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '10 days') RETURNING id
    `, [refundCustomerId, refundPlanId])).rows[0];
    const terminated = await subscriptionTermination.terminateForRefund(refundSub.id, refundCustomerId, { reason: 'test: confirmed refund' });
    assert.strictEqual(terminated.changed, true, 'terminateForRefund should have terminated the fixture subscription');

    const refundItem = await runExtend(refundCustomerId);
    assert.strictEqual(refundItem.status, 'failed', 'extend_entitlement must fail closed against a refund-terminated subscription, not silently succeed');
    assert(/no subscription to extend/i.test(String(refundItem.last_error || '')), `extend_entitlement should report no extendable subscription, got: ${refundItem.last_error}`);

    const refundSubAfter = (await query('SELECT status,service_extension_days,current_period_end FROM subscriptions WHERE id=$1', [refundSub.id])).rows[0];
    assert.strictEqual(refundSubAfter.status, 'cancelled', 'refund-terminated subscription must remain cancelled');
    assert.strictEqual(Number(refundSubAfter.service_extension_days || 0), 0, 'extend_entitlement must not grant service_extension_days on a refund-terminated subscription');
    assert(new Date(refundSubAfter.current_period_end).getTime() <= Date.now(), 'refund-terminated subscription must not have its period end pushed back into the future');

    // Case 2: an ordinary administrative plan termination (not a refund) must
    // remain extendable -- this fix must not block the legitimate
    // reactivate-a-lapsed-customer workflow.
    const localPlanId = await makePlan('local-ended');
    const localCustomerId = await makeCustomer('local-ended');
    const localSub = (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '10 days') RETURNING id
    `, [localCustomerId, localPlanId])).rows[0];
    await subscriptionTermination.terminateLocal(localSub.id, localCustomerId, { reason: 'test: admin ended plan' });

    const localItem = await runExtend(localCustomerId);
    // The service_extension_days write commits in its own transaction before
    // extend_entitlement's downstream provisioning.reconcileCustomer() call;
    // this fixture has no real Jellyfin server, so reconcile may itself fail
    // (or the job item end up 'failed') for reasons unrelated to what this
    // test checks -- currentSubscription() must find and extend this
    // non-refund-terminated subscription at all. Assert the persisted write
    // directly rather than the overall job item status.
    assert(!/no subscription to extend/i.test(String(localItem.last_error || '')), `currentSubscription() must still find an ordinarily-ended (non-refund) subscription to extend, got: ${localItem.last_error}`);
    const localSubAfter = (await query('SELECT service_extension_days FROM subscriptions WHERE id=$1', [localSub.id])).rows[0];
    assert(Number(localSubAfter.service_extension_days || 0) > 0, 'extend_entitlement should have granted service_extension_days on the non-refund-terminated subscription');

    console.log('bulk extend refund-termination safety DB smoke: ok');
})().finally(async () => {
    for (const customerId of created.customers.reverse()) {
        await query('DELETE FROM subscription_service_extension_events WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM background_job_items WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM subscriptions WHERE customer_id=$1', [customerId]).catch(() => {});
        await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
    }
    for (const planId of created.plans.reverse()) {
        await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
    }
    await getPool().end();
}).catch((error) => {
    console.error('bulk extend refund-termination safety DB smoke failed:', error);
    process.exit(1);
});
