'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('provider operation recovery DB smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const providerOps = require('../src/payments/provider-operations');

const remoteSubscriptions = new Map();
let providerMutationCount = 0;
const clone = value => JSON.parse(JSON.stringify(value));

class FakeStripe {
    constructor() {
        this.subscriptions = {
            retrieve: async id => {
                const row = remoteSubscriptions.get(id);
                if (!row) { const error = new Error(`No such subscription: ${id}`); error.statusCode = 404; throw error; }
                return clone(row);
            },
            update: async (id, body) => {
                const row = remoteSubscriptions.get(id);
                if (!row) { const error = new Error(`No such subscription: ${id}`); error.statusCode = 404; throw error; }
                const price = body?.items?.[0]?.price;
                if (price) row.items.data[0].price = { id: price };
                if (typeof body?.cancel_at_period_end === 'boolean') row.cancel_at_period_end = body.cancel_at_period_end;
                if (body?.metadata) row.metadata = { ...(row.metadata || {}), ...body.metadata };
                providerMutationCount += 1;
                return clone(row);
            }
        };
        this.subscriptionSchedules = {
            retrieve: async () => { throw new Error('schedule retrieval not expected in this smoke'); },
            create: async () => { throw new Error('schedule creation not expected in this smoke'); },
            update: async () => { throw new Error('schedule update not expected in this smoke'); }
        };
    }
}

const stripePath = require.resolve('stripe');
require(stripePath);
require.cache[stripePath].exports = FakeStripe;
process.env.STRIPE_API_KEY = 'sk_test_provider_recovery_smoke';
process.env.STRIPE_ENABLED = 'true';

const providerPricing = require('../src/payments/provider-plan-pricing');
const billingControl = require('../src/payments/billing-control');
const targetMappings = new Map();
providerPricing.getProviderPlanByExternalId = async (provider, externalId) => provider === 'stripe' ? targetMappings.get(externalId) || null : null;
billingControl.syncSubscription = async subscriptionId => ({ ok: true, subscriptionId, provider: 'stripe', remote: { status: 'active' } });
const recovery = require('../src/payments/provider-operation-recovery');

function suffix() { return crypto.randomBytes(6).toString('hex'); }
async function forceDue(id) { await query(`UPDATE provider_operations SET next_attempt_at=NOW()-INTERVAL '1 second' WHERE id=$1`, [id]); }
async function plan(code, name, price = 1000) {
    return (await query(`INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order) VALUES($1,$2,'direct','jellyfin','month',30,$3,'GBP',1,TRUE,TRUE,999) RETURNING *`, [code, name, price])).rows[0];
}
async function customer(tag) {
    return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [`Provider Recovery ${tag}`, `provider-recovery-${tag}@example.invalid`])).rows[0];
}
async function subscription(customerId, planId, providerSubscriptionId) {
    return (await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin') RETURNING *`, [customerId, planId, providerSubscriptionId])).rows[0];
}
function remote(id, priceId) {
    remoteSubscriptions.set(id, { id, status: 'active', cancel_at_period_end: false, metadata: {}, items: { data: [{ id: `si_${id}`, price: { id: priceId }, current_period_start: Math.floor(Date.now()/1000)-100, current_period_end: Math.floor(Date.now()/1000)+2592000 }] } });
}
async function immediateOp({ customerId, subscriptionId, targetPlanId, targetPriceId, key }) {
    return providerOps.begin({ provider: 'stripe', scope: 'customer', ownerId: customerId, operationType: 'plan_change_immediate', localReference: subscriptionId, idempotencyKey: key, request: { subscriptionId, targetPlanId, targetPlanPriceId: null, targetPriceId, currency: 'GBP', proration: true } });
}
async function row(table, id) { return (await query(`SELECT * FROM ${table} WHERE id=$1`, [id])).rows[0]; }

async function testAConcurrentRecurringSerialization() {
    const tag = suffix(), c = await customer(`a-${tag}`), p = await plan(`recovery-a-${tag}`, 'Concurrency Plan');
    const pool = getPool(), one = await pool.connect(), two = await pool.connect();
    let secondError = null;
    try {
        await one.query('BEGIN');
        await two.query('BEGIN');
        await one.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin')`, [c.id, p.id, `sub_serial_a_${tag}`]);
        const second = two.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','paypal','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin')`, [c.id, p.id, `I-SERIAL-B-${tag}`]).catch(error => { secondError = error; return null; });
        await new Promise(resolve => setTimeout(resolve, 80));
        await one.query('COMMIT');
        await second;
        if (secondError) await two.query('ROLLBACK'); else await two.query('COMMIT');
    } finally {
        try { await one.query('ROLLBACK'); } catch (_) {}
        try { await two.query('ROLLBACK'); } catch (_) {}
        one.release(); two.release();
    }
    assert(secondError, 'A: the second concurrent recurring activation must be rejected after serialization');
    const live = await query(`SELECT COUNT(*)::int n FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.customer_id=$1 AND s.superseded_by IS NULL AND s.source IN('stripe','paypal') AND s.billing_mode='subscription' AND s.status IN('active','trialing','past_due','paused') AND s.current_period_end>NOW() AND COALESCE(p.is_addon,FALSE)=FALSE AND COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')='jellyfin'`, [c.id]);
    assert.strictEqual(live.rows[0].n, 1, 'A: exactly one valid recurring subscription must emerge');
}

async function testBHIProviderSuccessLocalFailureAndIdempotentRetry() {
    const tag = suffix(), c = await customer(`bhi-${tag}`), oldPlan = await plan(`recovery-old-${tag}`, 'Old Plan', 1000), target = await plan(`recovery-target-${tag}`, 'Target Plan', 2000);
    const providerId = `sub_recovery_bhi_${tag}`, targetPrice = `price_recovery_target_${tag}`, sub = await subscription(c.id, oldPlan.id, providerId);
    targetMappings.set(targetPrice, { id: target.id, plan_price_id: null, provider_mapping_id: null, external_id: targetPrice, checkout_mode: 'subscription', price_minor: 2000, currency: 'GBP' });
    remote(providerId, `price_old_${tag}`);
    const op = await immediateOp({ customerId: c.id, subscriptionId: sub.id, targetPlanId: target.id, targetPriceId: targetPrice, key: `recovery-bhi-${tag}` });
    const fake = new FakeStripe();
    await fake.subscriptions.update(providerId, { items: [{ id: `si_${providerId}`, price: targetPrice }] });
    const mutationsAfterSuccess = providerMutationCount;
    await providerOps.providerApplied(op.id, { providerReference: providerId, result: { priceId: targetPrice } });
    await providerOps.recordError(op.id, new Error('intentional local transaction failure'), { terminal: true });
    let unresolved = await providerOps.get(op.id);
    assert.strictEqual(unresolved.state, 'provider_applied', 'B/H: provider success plus local failure must remain provider_applied');
    assert.strictEqual(unresolved.failure_kind, 'retryable', 'B/H: local failure after provider success must remain retryable');
    assert.strictEqual((await row('subscriptions', sub.id)).plan_id, oldPlan.id, 'H: failed local write must leave old local plan in place');
    await forceDue(op.id);
    const result = await recovery.run({ limit: 10 });
    assert.strictEqual(result.reconciled, 1, 'B/H: reconciler must complete the missing local side');
    assert.strictEqual((await row('subscriptions', sub.id)).plan_id, target.id, 'H: recovered plan change must apply target local plan');
    assert.strictEqual((await providerOps.get(op.id)).state, 'reconciled', 'B: operation must converge to reconciled');
    assert.strictEqual(providerMutationCount, mutationsAfterSuccess, 'I: retry must not duplicate a provider mutation when remote already reflects target');
}

async function testCECrashAndAlreadyDesiredState() {
    const tag = suffix(), c = await customer(`ce-${tag}`), oldPlan = await plan(`recovery-ce-old-${tag}`, 'Crash Old', 1000), target = await plan(`recovery-ce-target-${tag}`, 'Crash Target', 2100);
    const providerId = `sub_recovery_ce_${tag}`, targetPrice = `price_recovery_ce_${tag}`, sub = await subscription(c.id, oldPlan.id, providerId);
    targetMappings.set(targetPrice, { id: target.id, plan_price_id: null, provider_mapping_id: null, external_id: targetPrice, checkout_mode: 'subscription', price_minor: 2100, currency: 'GBP' });
    remote(providerId, `price_ce_old_${tag}`);
    const op = await immediateOp({ customerId: c.id, subscriptionId: sub.id, targetPlanId: target.id, targetPriceId: targetPrice, key: `recovery-ce-${tag}` });
    const fake = new FakeStripe();
    await fake.subscriptions.update(providerId, { items: [{ id: `si_${providerId}`, price: targetPrice }] });
    const beforeRecovery = providerMutationCount;
    // Simulates process death after Stripe success but before providerApplied().
    assert.strictEqual((await providerOps.get(op.id)).state, 'planned', 'C: crash window must leave a durable planned operation');
    await forceDue(op.id);
    const result = await recovery.run({ limit: 10 });
    assert.strictEqual(result.reconciled, 1, 'C/E: reconciler must converge a planned op whose provider already reflects desired state');
    assert.strictEqual(providerMutationCount, beforeRecovery, 'E/I: provider already desired must cause zero repeat provider mutation');
    assert.strictEqual((await row('subscriptions', sub.id)).plan_id, target.id);
}

async function testDConcurrentReconcilersClaimOnce() {
    const tag = suffix(), c = await customer(`d-${tag}`), oldPlan = await plan(`recovery-d-old-${tag}`, 'Concurrent Old', 1000), target = await plan(`recovery-d-target-${tag}`, 'Concurrent Target', 2200);
    const providerId = `sub_recovery_d_${tag}`, targetPrice = `price_recovery_d_${tag}`, sub = await subscription(c.id, oldPlan.id, providerId);
    targetMappings.set(targetPrice, { id: target.id, plan_price_id: null, provider_mapping_id: null, external_id: targetPrice, checkout_mode: 'subscription', price_minor: 2200, currency: 'GBP' });
    remote(providerId, targetPrice);
    const op = await immediateOp({ customerId: c.id, subscriptionId: sub.id, targetPlanId: target.id, targetPriceId: targetPrice, key: `recovery-d-${tag}` });
    await forceDue(op.id);
    const [a, b] = await Promise.all([recovery.run({ limit: 10 }), recovery.run({ limit: 10 })]);
    assert.strictEqual(a.total + b.total, 1, 'D: concurrent reconcilers must claim the operation once');
    assert.strictEqual((await providerOps.get(op.id)).state, 'reconciled');
}

async function testFDefinitiveProviderFailure() {
    const tag = suffix(), c = await customer(`f-${tag}`);
    const op = await providerOps.begin({ provider: 'stripe', scope: 'customer', ownerId: c.id, operationType: 'renewal_stop', idempotencyKey: `recovery-f-${tag}`, request: { subscriptionId: crypto.randomUUID(), providerSubscriptionId: `sub_f_${tag}`, desiredCancelAtPeriodEnd: true } });
    const error = new Error('Stripe rejected the request'); error.statusCode = 400;
    const failed = await providerOps.recordError(op.id, error);
    assert.strictEqual(failed.state, 'failed', 'F: definitive provider failure must become failed');
    assert.strictEqual(failed.failure_kind, 'terminal', 'F: definitive provider failure must be terminal');
    assert.strictEqual(failed.manual_review_required, true, 'F: definitive provider failure must surface for manual review');
    await forceDue(op.id);
    const claimed = await providerOps.claimRecoverable({ limit: 10 });
    assert(!claimed.some(row => row.id === op.id), 'F: terminal provider failure must not be blindly replayed');
}

async function testGAmbiguousProviderResult() {
    const tag = suffix(), c = await customer(`g-${tag}`);
    const op = await providerOps.begin({ provider: 'stripe', scope: 'customer', ownerId: c.id, operationType: 'renewal_stop', idempotencyKey: `recovery-g-${tag}`, request: { subscriptionId: crypto.randomUUID(), providerSubscriptionId: `sub_g_${tag}`, desiredCancelAtPeriodEnd: true } });
    const error = new Error('socket closed before response'); error.code = 'ECONNRESET';
    const pending = await providerOps.recordError(op.id, error, { terminal: true });
    assert.strictEqual(pending.state, 'planned', 'G: ambiguous provider result must not be classified as definitive failure');
    assert.strictEqual(pending.failure_kind, 'ambiguous', 'G: unknown result must be explicitly classified ambiguous');
    assert.strictEqual(pending.manual_review_required, false);
    assert(pending.next_attempt_at, 'G: ambiguous provider result must remain scheduled for verification');
}

async function testJOldOperationCannotOverwriteNewerDecision() {
    const tag = suffix(), c = await customer(`j-${tag}`), oldPlan = await plan(`recovery-j-old-${tag}`, 'Stale Old', 1000), staleTarget = await plan(`recovery-j-stale-${tag}`, 'Stale Target', 2300), newerTarget = await plan(`recovery-j-new-${tag}`, 'New Target', 2400);
    const providerId = `sub_recovery_j_${tag}`, stalePrice = `price_recovery_j_stale_${tag}`, newerPrice = `price_recovery_j_new_${tag}`, sub = await subscription(c.id, oldPlan.id, providerId);
    targetMappings.set(stalePrice, { id: staleTarget.id, plan_price_id: null, provider_mapping_id: null, external_id: stalePrice, checkout_mode: 'subscription', price_minor: 2300, currency: 'GBP' });
    targetMappings.set(newerPrice, { id: newerTarget.id, plan_price_id: null, provider_mapping_id: null, external_id: newerPrice, checkout_mode: 'subscription', price_minor: 2400, currency: 'GBP' });
    remote(providerId, newerPrice);
    const stale = await immediateOp({ customerId: c.id, subscriptionId: sub.id, targetPlanId: staleTarget.id, targetPriceId: stalePrice, key: `recovery-j-stale-${tag}` });
    await new Promise(resolve => setTimeout(resolve, 5));
    const newer = await immediateOp({ customerId: c.id, subscriptionId: sub.id, targetPlanId: newerTarget.id, targetPriceId: newerPrice, key: `recovery-j-new-${tag}` });
    await query(`UPDATE provider_operations SET next_attempt_at=NOW()+INTERVAL '1 hour' WHERE id=$1`, [newer.id]);
    await forceDue(stale.id);
    const before = providerMutationCount;
    const result = await recovery.run({ limit: 10 });
    assert.strictEqual(result.superseded, 1, 'J: stale unresolved operation must be superseded by newer commercial decision');
    const staleRow = await providerOps.get(stale.id);
    assert.strictEqual(staleRow.failure_kind, 'superseded');
    assert.strictEqual((await row('subscriptions', sub.id)).plan_id, oldPlan.id, 'J: stale operation must not overwrite local state');
    assert.strictEqual(providerMutationCount, before, 'J: stale operation must not mutate provider state');
}

async function main() {
    const columns = await query(`SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='provider_operations' AND column_name IN('attempt_count','next_attempt_at','failure_kind','manual_review_required')`);
    assert.strictEqual(columns.rowCount, 4, 'migration 109 provider recovery columns must be applied');
    await testAConcurrentRecurringSerialization();
    await testBHIProviderSuccessLocalFailureAndIdempotentRetry();
    await testCECrashAndAlreadyDesiredState();
    await testDConcurrentReconcilersClaimOnce();
    await testFDefinitiveProviderFailure();
    await testGAmbiguousProviderResult();
    await testJOldOperationCannotOverwriteNewerDecision();
    console.log('provider operation recovery DB smoke: A-J ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await getPool().end(); } catch (_) {} });
