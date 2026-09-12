'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const permanentAccess = require('../src/entitlements/permanent-access');
const termination = require('../src/payments/subscription-termination');
const paymentRetry = require('../src/payments/payment-event-retry');
const providerOps = require('../src/payments/provider-operations');
const integrity = require('../src/automation/revenue-integrity');
const integrityFreshness = require('../src/integrations/integrity-alert-freshness');

const suffix = crypto.randomBytes(5).toString('hex');
const created = { customers: [], plans: [], paymentEvents: [], providerOps: [], deletionJobs: [], notificationOutbox: [] };

async function createCustomer(label) {
    const result = await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`, [
        `Automation reliability ${label} ${suffix}`,
        `automation-reliability-${label}-${suffix}@example.invalid`
    ]);
    created.customers.push(result.rows[0].id);
    return result.rows[0].id;
}

async function createPlan(label, options = {}) {
    const result = await query(`
        INSERT INTO plans(
            code,name,audience,billing_interval,duration_days,price_minor,currency,streams,
            server_class,service_type,is_free_tier,is_addon,active,visible
        ) VALUES($1,$2,'direct','month',30,$3,'GBP',1,$4,$5,$6,FALSE,TRUE,TRUE)
        RETURNING id
    `, [
        `automation-reliability-${label}-${suffix}`,
        `Automation reliability ${label}`,
        options.priceMinor == null ? 999 : Number(options.priceMinor),
        options.serverClass || 'premium',
        options.serviceType || 'jellyfin',
        Boolean(options.free)
    ]);
    created.plans.push(result.rows[0].id);
    return result.rows[0].id;
}

async function createSubscription(customerId, planId, providerRef) {
    const result = await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,starts_at,current_period_end,
            provider_subscription_id,service_type_snapshot,billing_mode
        ) VALUES($1,$2,'active','stripe',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin','payment')
        RETURNING *
    `, [customerId, planId, providerRef]);
    return result.rows[0];
}

async function testRefundRevokesPinnedPermanentAccess() {
    const customerId = await createCustomer('refund-permanent');
    const planId = await createPlan('refund-permanent');
    const subscription = await createSubscription(customerId, planId, `pi_perm_${suffix}`);

    await permanentAccess.enable(customerId, { reason: 'DB smoke pinned permanent access' });
    const before = await query(`SELECT permanent_access,revoked_at,subscription_id FROM customer_entitlement_overrides WHERE customer_id=$1`, [customerId]);
    assert.strictEqual(before.rows[0]?.permanent_access, true, 'fixture must begin with Permanent Access enabled');
    assert.strictEqual(String(before.rows[0]?.subscription_id), String(subscription.id), 'Permanent Access must be pinned to the fixture subscription');

    const ended = await termination.terminateForRefund(subscription.id, customerId, { reason: 'Confirmed full refund DB smoke' });
    assert.strictEqual(ended.permanentAccessRevoked, true, 'refund termination must report Permanent Access revocation');
    const after = await query(`SELECT permanent_access,revoked_at FROM customer_entitlement_overrides WHERE customer_id=$1`, [customerId]);
    assert.strictEqual(after.rows[0]?.permanent_access, false, 'refund must revoke subscription-pinned Permanent Access');
    assert(after.rows[0]?.revoked_at, 'refund revocation must retain durable audit timestamp');
}

async function testUnsupportedPaymentEventIsNeverLeased() {
    const inserted = await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processing_error,processing_started_at,processing_token)
        VALUES('manual',$1,'manual.operator_event','{}'::jsonb,'Operator-owned event',NOW()-INTERVAL '10 minutes',NULL)
        RETURNING id,processing_started_at
    `, [`manual-reliability-${suffix}`]);
    const row = inserted.rows[0];
    created.paymentEvents.push(row.id);

    const claimed = await paymentRetry.claimSupportedRetryablePaymentEvents({ limit: 100 });
    assert(!claimed.some(item => String(item.id) === String(row.id)), 'unsupported/manual payment event must not be leased by automated retry');
    const after = await query(`SELECT processing_token,processing_started_at FROM payment_events WHERE id=$1`, [row.id]);
    assert.strictEqual(after.rows[0]?.processing_token, null, 'manual payment event must remain unclaimed for operator review');
    assert.strictEqual(new Date(after.rows[0].processing_started_at).getTime(), new Date(row.processing_started_at).getTime(), 'manual payment event retry timestamp must not be mutated by automation');
}

async function testPaidPlanCannotEnterFreePool() {
    let rejected = null;
    try {
        await createPlan('illegal-free-pool', { serverClass: 'free', free: false, priceMinor: 999 });
    } catch (error) {
        rejected = error;
    }
    assert(rejected, 'database must reject a paid/non-free plan using server_class=free');
    assert.strictEqual(String(rejected.code), '23514', `expected PostgreSQL check violation, got ${rejected.code || rejected.message}`);
}

async function testImmediatePlanChangeWakesReconciliation() {
    const customerId = await createCustomer('immediate-plan-change');
    const op = await providerOps.begin({
        provider: 'stripe',
        scope: 'customer',
        ownerId: customerId,
        operationType: 'plan_change_immediate',
        localReference: null,
        idempotencyKey: `automation-reliability-immediate-${suffix}`,
        request: { test: true }
    });
    created.providerOps.push(op.id);
    await providerOps.reconciled(op.id, { result: { test: true } });
    const state = await query(`SELECT status,last_attempt_at,last_success_at FROM customer_provisioning_state WHERE customer_id=$1`, [customerId]);
    assert.strictEqual(state.rowCount, 1, 'immediate plan-change reconciliation must create/update customer provisioning state');
    assert(state.rows[0].last_attempt_at || state.rows[0].last_success_at, 'immediate plan change must actually execute customer reconciliation');
}

async function testManualProviderOperationIsIntegrityFinding() {
    const customerId = await createCustomer('manual-provider-op');
    const op = await providerOps.begin({
        provider: 'stripe',
        scope: 'customer',
        ownerId: customerId,
        operationType: 'test_manual_recovery',
        idempotencyKey: `automation-reliability-manual-${suffix}`,
        request: { test: true }
    });
    created.providerOps.push(op.id);
    await providerOps.markManual(op.id, new Error('DB smoke manual review'));
    const findings = await integrity.scan();
    assert(findings.some(item => item.kind === 'provider_manual_review' && String(item.id) === String(op.id)), 'manual-review provider operation must be surfaced by integrity watchdog');
}

async function testDeletionTargetRefreshesParentLease() {
    const syntheticCustomerId = crypto.randomUUID();
    const job = await query(`
        INSERT INTO customer_deletion_jobs(customer_id,reason,status,updated_at)
        VALUES($1,'Automation reliability deletion heartbeat','running',NOW()-INTERVAL '1 hour')
        RETURNING id,updated_at
    `, [syntheticCustomerId]);
    created.deletionJobs.push(job.rows[0].id);
    const before = new Date(job.rows[0].updated_at).getTime();

    await query(`
        INSERT INTO customer_external_deletion_targets(
            deletion_job_id,customer_id,provider,resource_type,external_identifier,state,updated_at
        ) VALUES($1,$2,'jellyfin','user',$3,'pending',NOW())
    `, [job.rows[0].id, syntheticCustomerId, `heartbeat:${suffix}`]);

    const after = await query('SELECT updated_at FROM customer_deletion_jobs WHERE id=$1', [job.rows[0].id]);
    assert(after.rowCount, 'deletion heartbeat fixture job must still exist');
    assert(new Date(after.rows[0].updated_at).getTime() > before, 'durable deletion target progress must refresh the parent deletion job lease');
}

async function testResolvedIntegrityAlertIsSuppressedBeforeDelivery() {
    const event = await query(`
        INSERT INTO payment_events(
            provider,provider_event_id,event_type,payload,processing_error,created_at
        ) VALUES(
            'plisio',$1,'operation.pending',$2::jsonb,'Synthetic stale Plisio event',NOW()-INTERVAL '60 minutes'
        )
        RETURNING id
    `, [
        `integrity-freshness-${suffix}`,
        JSON.stringify({ txn_id: `integrity-freshness-${suffix}`, status: 'pending' })
    ]);
    created.paymentEvents.push(event.rows[0].id);

    const findings = await integrity.scan();
    assert(
        findings.some(item => item.kind === 'payment_event_stale' && String(item.id) === String(event.rows[0].id)),
        'stale supported payment event must enter the integrity snapshot'
    );

    const snapshot = integrity.fingerprint(findings);
    const dedupeKey = `admin:db-smoke:discord:automation-integrity:${snapshot}:12345`;
    const fresh = await integrityFreshness.evaluate({ dedupe_key: dedupeKey });
    assert.strictEqual(fresh.guarded, true, 'integrity alert dedupe key must activate delivery freshness protection');
    assert.strictEqual(fresh.fresh, true, 'unchanged integrity snapshot must remain deliverable');

    await query(`
        UPDATE payment_events
        SET processed_at=NOW(),processing_error=NULL,processing_started_at=NULL,processing_token=NULL
        WHERE id=$1
    `, [event.rows[0].id]);

    const resolved = await integrityFreshness.evaluate({ dedupe_key: dedupeKey });
    assert.strictEqual(resolved.fresh, false, 'resolved payment failure must invalidate the queued integrity snapshot');

    const outbox = await query(`
        INSERT INTO notification_outbox(
            channel,message_type,event_type,destination,payload,dedupe_key,status,next_attempt_at,last_attempt_at
        ) VALUES(
            'discord','automation.integrity.failed','automation.integrity.failed','db-smoke-destination',
            '{}'::jsonb,$1,'sending',NOW(),NOW()
        )
        RETURNING id,dedupe_key
    `, [dedupeKey]);
    created.notificationOutbox.push(outbox.rows[0].id);

    const suppressed = await integrityFreshness.cancelIfStale(outbox.rows[0]);
    assert.strictEqual(suppressed.cancelled, true, 'resolved integrity alert must be cancelled before external delivery');

    const after = await query(`SELECT status,dedupe_key,payload FROM notification_outbox WHERE id=$1`, [outbox.rows[0].id]);
    assert.strictEqual(after.rows[0]?.status, 'cancelled', 'suppressed alert must use the durable cancelled outbox state');
    assert.strictEqual(after.rows[0]?.dedupe_key, null, 'suppressed alert must release its dedupe key for a future genuine recurrence');
    assert(after.rows[0]?.payload?.suppressed_reason, 'suppressed alert must retain a durable reason for operator audit');
}

async function cleanup() {
    if (created.notificationOutbox.length) await query(`DELETE FROM notification_outbox WHERE id=ANY($1::uuid[])`, [created.notificationOutbox]).catch(() => {});
    if (created.deletionJobs.length) await query(`DELETE FROM customer_deletion_jobs WHERE id=ANY($1::uuid[])`, [created.deletionJobs]).catch(() => {});
    if (created.paymentEvents.length) await query(`DELETE FROM payment_events WHERE id=ANY($1::uuid[])`, [created.paymentEvents]).catch(() => {});
    if (created.providerOps.length) await query(`DELETE FROM provider_operations WHERE id=ANY($1::uuid[])`, [created.providerOps]).catch(() => {});
    for (const customerId of [...created.customers].reverse()) {
        await query(`DELETE FROM customer_entitlement_overrides WHERE customer_id=$1`, [customerId]).catch(() => {});
        await query(`DELETE FROM customer_provisioning_state WHERE customer_id=$1`, [customerId]).catch(() => {});
        await query(`DELETE FROM subscriptions WHERE customer_id=$1`, [customerId]).catch(() => {});
        await query(`DELETE FROM customers WHERE id=$1`, [customerId]).catch(() => {});
    }
    for (const planId of [...created.plans].reverse()) await query(`DELETE FROM plans WHERE id=$1`, [planId]).catch(() => {});
}

(async () => {
    try {
        await testRefundRevokesPinnedPermanentAccess();
        await testUnsupportedPaymentEventIsNeverLeased();
        await testPaidPlanCannotEnterFreePool();
        await testImmediatePlanChangeWakesReconciliation();
        await testManualProviderOperationIsIntegrityFinding();
        await testDeletionTargetRefreshesParentLease();
        await testResolvedIntegrityAlertIsSuppressedBeforeDelivery();
        console.log('automation reliability audit DB smoke: ok');
    } finally {
        await cleanup();
        await getPool().end();
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
