'use strict';

// DB-backed regression test: the admin bulk "Extend" action
// (src/platform/bulk-operations.js's extend_entitlement handler) must never
// mutate an older primary subscription after the customer's newest contract
// was terminated for a confirmed refund/chargeback. The terminal refund is a
// boundary for the whole current-contract decision, not merely a row to filter
// out of a fallback query.
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
    // Case 1: customer has an older still-live subscription, then a newer
    // contract that was refunded. Filtering the refunded row out before
    // ordering would expose the older row and extend it; checking the newest
    // contract first must fail closed instead.
    const refundPlanId = await makePlan('refunded');
    const refundCustomerId = await makeCustomer('refunded');
    const olderSub = (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,created_at)
        VALUES($1,$2,'active','manual',NOW()-INTERVAL '60 days',NOW()+INTERVAL '20 days',NOW()-INTERVAL '60 days') RETURNING id
    `, [refundCustomerId, refundPlanId])).rows[0];
    const refundSub = (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,created_at)
        VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '10 days',NOW()) RETURNING id
    `, [refundCustomerId, refundPlanId])).rows[0];
    const terminated = await subscriptionTermination.terminateForRefund(refundSub.id, refundCustomerId, { reason: 'test: confirmed refund' });
    assert.strictEqual(terminated.changed, true, 'terminateForRefund should have terminated the fixture subscription');

    const refundItem = await runExtend(refundCustomerId);
    assert.strictEqual(refundItem.status, 'failed', 'extend_entitlement must fail closed when the newest primary subscription is refund-terminated');
    assert(/no subscription to extend/i.test(String(refundItem.last_error || '')), `extend_entitlement should report no extendable subscription, got: ${refundItem.last_error}`);

    const refundSubAfter = (await query('SELECT status,service_extension_days,current_period_end FROM subscriptions WHERE id=$1', [refundSub.id])).rows[0];
    assert.strictEqual(refundSubAfter.status, 'cancelled', 'refund-terminated subscription must remain cancelled');
    assert.strictEqual(Number(refundSubAfter.service_extension_days || 0), 0, 'refund-terminated subscription must not receive service_extension_days');
    assert(new Date(refundSubAfter.current_period_end).getTime() <= Date.now(), 'refund-terminated subscription must not have its period end pushed back into the future');

    const olderSubAfter = (await query('SELECT service_extension_days FROM subscriptions WHERE id=$1', [olderSub.id])).rows[0];
    assert.strictEqual(Number(olderSubAfter.service_extension_days || 0), 0, 'older subscription must not be selected or extended behind a newer terminal refund');

    // Case 1b: protect the actual write boundary too. A worker can select a
    // subscription before a concurrent refund commits, then attempt its event
    // insert afterwards. The DB trigger locks the subscription row and refuses
    // that stale event once refund_terminated_at is visible, so the enclosing
    // extension transaction cannot leave a phantom "extension applied" event.
    let boundaryRejected = false;
    const staleReference = `bulk-refund-boundary-${suffix}`;
    try {
        await query(`
            INSERT INTO subscription_service_extension_events(
                subscription_id,customer_id,source,days,reference_id,metadata
            ) VALUES($1,$2,'admin_bulk',30,$3,$4::jsonb)
        `, [refundSub.id, refundCustomerId, staleReference, JSON.stringify({ test: true, staleSelection: true })]);
    } catch (error) {
        boundaryRejected = /confirmed refund|subscription_service_extension_events_refund_terminal/i.test(String(error?.message || error));
    }
    assert.strictEqual(boundaryRejected, true, 'extension event creation must be rejected after the refund boundary commits');
    const staleEvents = await query(
        `SELECT COUNT(*)::int count FROM subscription_service_extension_events WHERE source='admin_bulk' AND reference_id=$1`,
        [staleReference]
    );
    assert.strictEqual(Number(staleEvents.rows[0]?.count || 0), 0, 'rejected stale extension must not leave an event row behind');

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
    // for reasons unrelated to what this test checks. Assert the persisted
    // extension directly and only reject the currentSubscription failure.
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
