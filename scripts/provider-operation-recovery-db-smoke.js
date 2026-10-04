'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('provider operation recovery DB smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const providerOps = require('../src/payments/provider-operations');
const provisioningHelpers = require('../src/jellyfin/provisioning-helpers');
const resilientProvisioning = require('../src/jellyfin/resilient-provisioning');
resilientProvisioning.reconcileCustomer = async customerId => ({ customerId, active: true, testStub: true });
const incidents = require('../src/payments/incidents');
const incidentReconciliation = require('../src/payments/incident-reconciliation');

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
async function mediaServer(tag, location, maxUsers = 1) {
    return (await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,media_server_type,base_url,public_url,location,
            api_key_encrypted,enabled,allow_new_users,paid_enabled,trial_enabled,
            priority,max_users,health_status,placement_mode
        ) VALUES($1,$2,'premium','jellyfin',$3,$3,$4,'test-key',TRUE,TRUE,TRUE,TRUE,100,$5,'healthy','active')
        RETURNING *
    `, [`Recovery server ${tag}`, `recovery-server-${tag}`, `https://recovery-${tag}.example.invalid`, location, maxUsers])).rows[0];
}
function remote(id, priceId) {
    remoteSubscriptions.set(id, { id, status: 'active', cancel_at_period_end: false, metadata: {}, items: { data: [{ id: `si_${id}`, price: { id: priceId }, current_period_start: Math.floor(Date.now()/1000)-100, current_period_end: Math.floor(Date.now()/1000)+2592000 }] } });
}
async function immediateOp({ customerId, subscriptionId, targetPlanId, targetPriceId, key, targetMediaLocation = null, targetMediaServerId = null, targetAccessQuantity = null, targetVariantKind = null }) {
    return providerOps.begin({ provider: 'stripe', scope: 'customer', ownerId: customerId, operationType: 'plan_change_immediate', localReference: subscriptionId, idempotencyKey: key, request: { subscriptionId, targetPlanId, targetPlanPriceId: null, targetPriceId, currency: 'GBP', proration: true, targetMediaLocation, targetMediaServerId, targetAccessQuantity, targetVariantKind } });
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
    const tag = suffix(), c = await customer(`bhi-${tag}`), competing = await customer(`bhi-competing-${tag}`), oldPlan = await plan(`recovery-old-${tag}`, 'Old Plan', 1000), target = await plan(`recovery-target-${tag}`, 'Target Plan', 2000);
    const oldServer = await mediaServer(`old-${tag}`, 'Old Region', 10), targetServer = await mediaServer(`target-${tag}`, 'London', 1);
    const providerId = `sub_recovery_bhi_${tag}`, targetPrice = `price_recovery_target_${tag}`, sub = await subscription(c.id, oldPlan.id, providerId);
    await query(`UPDATE subscriptions SET media_server_id=$2,media_location_preference='Old Region',media_location_snapshot='Old Region' WHERE id=$1`, [sub.id, oldServer.id]);
    const variantId=crypto.randomUUID();
    targetMappings.set(targetPrice, { id: target.id, plan_price_id: null, provider_mapping_id: null, access_variant_id: variantId, variant_kind: 'streams', access_quantity: 3, quantity: 3, streams: 3, external_id: targetPrice, checkout_mode: 'subscription', price_minor: 2000, currency: 'GBP' });
    remote(providerId, `price_old_${tag}`);
    const op = await immediateOp({ customerId: c.id, subscriptionId: sub.id, targetPlanId: target.id, targetPriceId: targetPrice, key: `recovery-bhi-${tag}`, targetMediaLocation: 'London', targetMediaServerId: targetServer.id, targetAccessQuantity: 3, targetVariantKind: 'streams' });
    const preAdmission = await provisioningHelpers.reservePlacement(competing.id, targetServer);
    assert(preAdmission.placement_lease_id, 'H: merely creating a provider operation must not reserve physical capacity before admission succeeds');
    await provisioningHelpers.releaseDefinitivePlacementFailure(competing.id, targetServer.id, preAdmission.placement_lease_id);
    await query(`UPDATE provider_operations
      SET provider_result=provider_result||'{"capacityReserved":true}'::jsonb
      WHERE id=$1`, [op.id]);
    const ownPreMutation = await provisioningHelpers.reservePlacement(c.id, targetServer);
    assert(ownPreMutation.placement_lease_id, 'H: an immediate plan change must be able to materialize its own durable reservation when taking the final server slot');
    await provisioningHelpers.releaseDefinitivePlacementFailure(c.id, targetServer.id, ownPreMutation.placement_lease_id);
    await assert.rejects(
        provisioningHelpers.reservePlacement(competing.id,targetServer),
        error=>error?.code==='JELLYFIN_SERVER_CAPACITY_CHANGED',
        'H: another customer must remain blocked by the durable immediate-change reservation after the short lease is released'
    );
    const fake = new FakeStripe();
    await fake.subscriptions.update(providerId, { items: [{ id: `si_${providerId}`, price: targetPrice }] });
    const mutationsAfterSuccess = providerMutationCount;
    await providerOps.providerApplied(op.id, { providerReference: providerId, result: { priceId: targetPrice } });
    await providerOps.recordError(op.id, new Error('intentional local transaction failure'), { terminal: true });
    let unresolved = await providerOps.get(op.id);
    assert.strictEqual(unresolved.state, 'provider_applied', 'B/H: provider success plus local failure must remain provider_applied');
    assert.strictEqual(unresolved.failure_kind, 'retryable', 'B/H: local failure after provider success must remain retryable');
    assert.strictEqual((await row('subscriptions', sub.id)).plan_id, oldPlan.id, 'H: failed local write must leave old local plan in place');
    await assert.rejects(
        provisioningHelpers.reservePlacement(competing.id,targetServer),
        error=>error?.code==='JELLYFIN_SERVER_CAPACITY_CHANGED',
        'H: provider-success/local-failure recovery must keep the paid target server reserved even without a live placement lease'
    );
    await forceDue(op.id);
    const result = await recovery.run({ limit: 10 });
    assert.strictEqual(result.reconciled, 1, 'B/H: reconciler must complete the missing local side');
    const recoveredSubscription = await row('subscriptions', sub.id);
    assert.strictEqual(recoveredSubscription.plan_id, target.id, 'H: recovered plan change must apply target local plan');
    assert.strictEqual(String(recoveredSubscription.media_server_id), String(targetServer.id), 'H: recovery must preserve the exact paid target server assignment');
    assert.strictEqual(recoveredSubscription.media_location_preference, 'London', 'H: recovery must preserve the chosen paid target location');
    assert.strictEqual(recoveredSubscription.media_location_snapshot, 'London', 'H: recovery must snapshot the chosen paid target location');
    const recoveredContract=typeof recoveredSubscription.commercial_snapshot==='string'?JSON.parse(recoveredSubscription.commercial_snapshot):recoveredSubscription.commercial_snapshot;
    assert.strictEqual(recoveredContract.accessVariantId,variantId,'H: recovery must preserve the exact paid access variant identity');
    assert.strictEqual(recoveredContract.accessVariantKind,'streams','H: recovery must preserve the paid access variant kind');
    assert.strictEqual(Number(recoveredContract.accessQuantity),3,'H: recovery must preserve the paid access quantity instead of falling back to the base plan');
    assert.strictEqual(Number(recoveredContract.streams),3,'H: recovered Jellyfin entitlement must expose the stream allowance Stripe actually billed');
    const ownFinalSlot = await provisioningHelpers.reservePlacement(c.id, targetServer);
    assert(ownFinalSlot.placement_lease_id, 'H: provisioning must be allowed to materialize a customer whose own subscription already occupies the final physical slot');
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

async function testKProviderBillingIdentitySingleOwner() {
    const tag = suffix(), firstCustomer = await customer(`k-first-${tag}`), secondCustomer = await customer(`k-second-${tag}`);
    const firstPlan = await plan(`recovery-k-first-${tag}`, 'Provider identity first', 1200);
    const secondPlan = await plan(`recovery-k-second-${tag}`, 'Provider identity second', 1200);
    const providerId = `sub_provider_owner_${tag}`;
    const pool = getPool(), one = await pool.connect(), two = await pool.connect();
    let secondError = null;
    try {
        await one.query('BEGIN');
        await two.query('BEGIN');
        await one.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin')`, [firstCustomer.id, firstPlan.id, providerId]);
        const competing = two.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin')`, [secondCustomer.id, secondPlan.id, providerId]).catch(error => { secondError = error; return null; });
        await new Promise(resolve => setTimeout(resolve, 80));
        await one.query('COMMIT');
        await competing;
        if (secondError) await two.query('ROLLBACK'); else await two.query('COMMIT');
    } finally {
        try { await one.query('ROLLBACK'); } catch (_) {}
        try { await two.query('ROLLBACK'); } catch (_) {}
        one.release(); two.release();
    }
    assert(secondError, 'K: concurrent customers must not claim the same external provider billing identity');
    assert.match(String(secondError.message || secondError), /already attached to another subscription/i, 'K: provider identity guard must reject the duplicate at the database boundary');
    const owners = await query(`SELECT COUNT(*)::int n FROM subscriptions WHERE source='stripe' AND provider_subscription_id=$1`, [providerId]);
    assert.strictEqual(Number(owners.rows[0].n), 1, 'K: exactly one local subscription may own the provider identity after the race');

    // The pre-existing exact unique index cannot see formatting variants. The
    // normalized database guard must still prevent a second local owner from
    // claiming the same external one-time identity with hidden whitespace.
    const plisioId=`txn_provider_owner_${tag}`;
    await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','plisio','payment',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin')`,[firstCustomer.id,firstPlan.id,plisioId]);
    await assert.rejects(
        query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','plisio','payment',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin')`,[secondCustomer.id,secondPlan.id,` ${plisioId} `]),
        /already attached to another subscription/i,
        'K: normalized provider identity ownership must reject whitespace variants that bypass the exact unique index'
    );
}

async function testLRecurringIdentityStatusBoundary() {
    const tag=suffix(), c=await customer(`l-${tag}`), p=await plan(`recovery-l-${tag}`,'Identity Boundary');
    await assert.rejects(
        query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot,commercial_snapshot) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin',$4::jsonb)`,[c.id,p.id,`bad_recurring_${tag}`,JSON.stringify({checkoutMode:'subscription'})]),
        /Invalid recurring provider billing identity/i,
        'L: a live recurring Stripe row must not be created with a malformed provider identity'
    );
    const historical=await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'cancelled','stripe','subscription',NOW()-INTERVAL '60 days',NOW()-INTERVAL '30 days',NULL,'jellyfin') RETURNING id`,[c.id,p.id]);
    assert.strictEqual(historical.rowCount,1,'L: terminal historical recurring rows may remain without an operable provider identity for audit/import compatibility');
    await query(`UPDATE subscriptions SET cancel_at_period_end=TRUE WHERE id=$1`,[historical.rows[0].id]);
    await assert.rejects(
        query(`UPDATE subscriptions SET status='active' WHERE id=$1`,[historical.rows[0].id]),
        /Invalid recurring provider billing identity/i,
        'L: terminal malformed historical rows cannot be revived into paid access without a valid provider identity'
    );
    // Reproduce a pre-migration ACTIVE bad reference. Temporarily disable
    // only this new guard inside one transaction; a rollback restores the
    // trigger if the fixture insert itself fails.
    const oldLive=await customer(`old-live-${tag}`);
    const conn=await getPool().connect();
    let oldLiveId;
    try{
        await conn.query('BEGIN');
        await conn.query('ALTER TABLE subscriptions DISABLE TRIGGER subscriptions_provider_identity_guard');
        const inserted=await conn.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot)
            VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin') RETURNING id
        `,[oldLive.id,p.id,`bad_old_live_${tag}`]);
        oldLiveId=inserted.rows[0].id;
        await conn.query('ALTER TABLE subscriptions ENABLE TRIGGER subscriptions_provider_identity_guard');
        await conn.query('COMMIT');
    }catch(error){
        await conn.query('ROLLBACK');
        throw error;
    }finally{conn.release();}
    await query(`UPDATE subscriptions SET status='past_due' WHERE id=$1`,[oldLiveId]);
    await query(`UPDATE subscriptions SET current_period_end=NOW()+INTERVAL '25 days' WHERE id=$1`,[oldLiveId]);
    await assert.rejects(
        query(`UPDATE subscriptions SET status='active' WHERE id=$1`,[oldLiveId]),
        /Invalid recurring provider billing identity/i,
        'L: historical malformed paid subscriptions must not regain active service until repaired'
    );
    await query(`UPDATE subscriptions SET provider_subscription_id=$2 WHERE id=$1`,[oldLiveId,`sub_repaired_${tag}`]);
    await query(`UPDATE subscriptions SET status='active' WHERE id=$1`,[oldLiveId]);
    const repaired=await query(`SELECT status,provider_subscription_id FROM subscriptions WHERE id=$1`,[oldLiveId]);
    assert.strictEqual(repaired.rows[0].status,'active','L: repairing historical billing identity restores normal status synchronization');
}

async function testMHistoricalDuplicateIdentityRemainsReconcileable() {
    const tag=suffix(), firstCustomer=await customer(`m-first-${tag}`), secondCustomer=await customer(`m-second-${tag}`), thirdCustomer=await customer(`m-third-${tag}`);
    const p=await plan(`recovery-m-${tag}`,'Legacy duplicate identity');
    const providerId=`sub_legacy_duplicate_${tag}`;
    const conn=await getPool().connect();
    let firstId, secondId;
    try{
        await conn.query('BEGIN');
        await conn.query('ALTER TABLE subscriptions DISABLE TRIGGER subscriptions_provider_identity_guard');
        firstId=(await conn.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot)
            VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin') RETURNING id
        `,[firstCustomer.id,p.id,providerId])).rows[0].id;
        secondId=(await conn.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot)
            VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin') RETURNING id
        `,[secondCustomer.id,p.id,`  ${providerId}  `])).rows[0].id;
        await conn.query('ALTER TABLE subscriptions ENABLE TRIGGER subscriptions_provider_identity_guard');
        await conn.query('COMMIT');
    }catch(error){
        await conn.query('ROLLBACK');
        throw error;
    }finally{conn.release();}

    const ambiguousIdentity=await incidents.identityFromProviderSubscription('stripe',providerId);
    assert.strictEqual(ambiguousIdentity.scope,'unresolved','M: a normalized provider identity owned by different customers must never be assigned arbitrarily');
    assert.strictEqual(ambiguousIdentity.ambiguous,true,'M: ambiguous historical ownership must remain explicit to callers');
    await assert.rejects(
        incidentReconciliation.localMatch('stripe',providerId),
        /multiple customers/i,
        'M: unresolved incident reconciliation must fail closed when normalized provider ownership spans customers'
    );
    const scopedMatch=await incidentReconciliation.localMatch('stripe',providerId,firstCustomer.id);
    assert.strictEqual(String(scopedMatch?.owner_id),String(firstCustomer.id),'M: already-direct incident identity may safely scope a normalized provider match to its known customer');

    await query(`UPDATE subscriptions SET status='past_due' WHERE id=$1`,[firstId]);
    await query(`UPDATE subscriptions SET status='cancelled',cancel_at_period_end=TRUE,current_period_end=LEAST(current_period_end,NOW()) WHERE id=$1`,[secondId]);
    const reconciled=await query(`SELECT id,status FROM subscriptions WHERE id=ANY($1::uuid[]) ORDER BY id`,[[firstId,secondId]]);
    assert.deepStrictEqual(new Set(reconciled.rows.map(row=>row.status)),new Set(['past_due','cancelled']),'M: historical duplicate rows must remain writable for delinquency/cancellation reconciliation');

    await query(`UPDATE subscriptions SET status='cancelled',cancel_at_period_end=TRUE,current_period_end=LEAST(current_period_end,NOW()) WHERE id=$1`,[firstId]);
    await assert.rejects(
        query(`UPDATE subscriptions SET status='active',current_period_end=NOW()+INTERVAL '30 days' WHERE id=$1`,[firstId]),
        /already attached to another subscription/i,
        'M: reactivating a valid historical identity must fail while a normalized duplicate row still exists'
    );
    await assert.rejects(
        query(`UPDATE subscriptions SET status='active' WHERE id=$1`,[secondId]),
        /Invalid recurring provider billing identity/i,
        'M: a historical whitespace-padded provider ID must not be reactivated until repaired'
    );

    await assert.rejects(
        query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,billing_mode,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','stripe','subscription',NOW(),NOW()+INTERVAL '30 days',$3,'jellyfin')`,[thirdCustomer.id,p.id,` ${providerId} `]),
        /Invalid recurring provider billing identity/i,
        'M: new whitespace-padded recurring provider identities must be rejected before they can become ambiguous ownership'
    );
}

async function testNOrphanedIncidentMetadataCustomer() {
    const tag=suffix(), stale=await customer(`n-orphan-${tag}`);
    const staleId=stale.id;
    await query(`DELETE FROM customers WHERE id=$1`,[staleId]);

    const identity=await incidents.identityFromMetadata({internal_customer_id:staleId});
    assert.strictEqual(identity.scope,'unresolved','N: deleted metadata customer must downgrade to unresolved identity');
    assert.strictEqual(identity.customerId,null,'N: deleted metadata customer must never be written through the payment_incidents customer FK');
    assert.strictEqual(String(identity.orphanedCustomerId),String(staleId),'N: orphaned metadata identity should remain diagnosable in memory');

    const recorded=await incidents.record({
        provider:'stripe',
        eventId:`evt_orphan_refund_${tag}`,
        caseId:`ch_orphan_refund_${tag}`,
        kind:'refund',
        status:'recorded',
        identity,
        providerSubscriptionId:`pi_orphan_refund_${tag}`,
        amountMinor:600,
        currency:'USD',
        metadata:{internal_customer_id:staleId,fullRefund:true,originalAmountMinor:600}
    });
    assert.strictEqual(recorded.incident.scope,'unresolved','N: orphaned historical refund must remain durable without inventing a live customer');
    assert.strictEqual(recorded.incident.customer_id,null,'N: orphaned historical refund must store NULL customer_id');
    assert.strictEqual(Number(recorded.incident.amount_minor),600,'N: historical refund amount must still be preserved');
    assert.strictEqual(recorded.incident.metadata.internal_customer_id,String(staleId),'N: original provider metadata must preserve the deleted customer reference for audit');

    const callerSupplied=await incidents.record({
        provider:'stripe',
        eventId:`evt_orphan_direct_${tag}`,
        caseId:`ch_orphan_direct_${tag}`,
        kind:'refund',
        status:'recorded',
        identity:{scope:'direct',customerId:staleId},
        providerSubscriptionId:`pi_orphan_direct_${tag}`,
        amountMinor:600,
        currency:'USD',
        metadata:{internal_customer_id:staleId,fullRefund:true,originalAmountMinor:600}
    });
    assert.strictEqual(callerSupplied.incident.scope,'unresolved','N: record() must revalidate caller-supplied direct identities after customer deletion');
    assert.strictEqual(callerSupplied.incident.customer_id,null,'N: record() must not persist a stale caller-supplied customer FK');

    const malformed=await incidents.identityFromMetadata({internal_customer_id:'not-a-uuid'});
    assert.strictEqual(malformed.scope,'unresolved','N: malformed historical metadata customer IDs must fail closed instead of throwing a UUID cast error');
    assert.strictEqual(malformed.customerId,null,'N: malformed historical metadata customer IDs must never become direct identity');
}

async function testOScheduledStripeMediaCapacityReservation() {
    const tag=suffix(), first=await customer(`o-first-${tag}`), second=await customer(`o-second-${tag}`);
    const currentPlan=await plan(`recovery-o-current-${tag}`,'Scheduled current',1000);
    const targetPlan=await plan(`recovery-o-target-${tag}`,'Scheduled target',2000);
    const targetServer=await mediaServer(`scheduled-${tag}`,'London',1);
    const current=await subscription(first.id,currentPlan.id,`sub_scheduled_o_${tag}`);
    const change=(await query(`
        INSERT INTO customer_plan_changes(
            customer_id,current_subscription_id,target_plan_id,provider,mode,state,effective_at,
            target_media_location,target_media_server_id
        ) VALUES($1,$2,$3,'stripe','period_end','pending',NOW()+INTERVAL '30 days','London',$4)
        RETURNING *
    `,[first.id,current.id,targetPlan.id,targetServer.id])).rows[0];

    const capacity=require('../src/jellyfin/user-capacity');
    const occupied=await capacity.serverState(targetServer.id);
    assert.strictEqual(occupied.capacity_users,1,'O: pending scheduled Stripe change must reserve the exact future server slot');
    assert.strictEqual(occupied.full,true,'O: max-users=1 target server must be full while the Stripe change is pending');

    await assert.rejects(
        provisioningHelpers.reservePlacement(second.id,targetServer),
        error=>error?.code==='JELLYFIN_SERVER_CAPACITY_CHANGED',
        'O: a competing customer must not consume capacity already promised to a scheduled paid renewal'
    );

    await query(`UPDATE customer_plan_changes SET state='cancelled',updated_at=NOW() WHERE id=$1`,[change.id]);
    const afterCancel=await provisioningHelpers.reservePlacement(second.id,targetServer);
    assert(afterCancel.placement_lease_id,'O: cancelling the scheduled change must release its durable physical-capacity reservation');
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
    await testKProviderBillingIdentitySingleOwner();
    await testLRecurringIdentityStatusBoundary();
    await testMHistoricalDuplicateIdentityRemainsReconcileable();
    await testNOrphanedIncidentMetadataCustomer();
    await testOScheduledStripeMediaCapacityReservation();
    console.log('provider operation recovery DB smoke: A-O ok');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => { try { await getPool().end(); } catch (_) {} });
