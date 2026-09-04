'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { query, transaction, getPool } = require('../src/db');
const affiliateCredits = require('../src/affiliate-credits');
const serviceCreditAccounting = require('../src/payments/service-credit-accounting');
const customerDeletion = require('../src/platform/customer-deletion');
const checkoutIntents = require('../src/payments/checkout-intents');
const lifecycle = require('../src/payments/lifecycle-primitives');

const suffix = crypto.randomBytes(6).toString('hex');
function unique(label) { return `${label}-${suffix}-${crypto.randomBytes(3).toString('hex')}`; }
async function customer(label) {
    return (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING *`, [
        `${label} ${suffix}`,
        `${unique(label)}@example.invalid`
    ])).rows[0];
}
async function balance(customerId) {
    return (await affiliateCredits.balances(customerId)).find(row => row.currency === 'GBP') || { available_minor: 0, recoverable_minor: 0 };
}
async function jellyfinServer(serverClass, maxUsers, label) {
    return (await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,media_server_type,base_url,public_url,api_key_encrypted,
            enabled,priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled,placement_mode
        ) VALUES($1,$2,$3,'jellyfin','https://example.invalid','https://example.invalid','test-key',
                 TRUE,1,$4,'healthy',TRUE,TRUE,TRUE,'active')
        RETURNING *
    `, [`${label} ${suffix}`, unique(label), serverClass, maxUsers])).rows[0];
}

async function affiliateDeletionInvariant() {
    const affiliate = await customer('delete-affiliate');
    const referred = await customer('delete-referred');
    await affiliateCredits.enroll(affiliate.id);

    const grant = (await query(`
        INSERT INTO affiliate_credit_ledger(
            customer_id,referred_customer_id,currency,amount_minor,entry_type,state,reference_id,note,metadata
        ) VALUES($1,$2,'GBP',2500,'earned','available',$3,'hard-delete invariant grant','{}'::jsonb)
        RETURNING *
    `, [affiliate.id, referred.id, unique('grant')])).rows[0];

    const debit = await transaction(async client => {
        await serviceCreditAccounting.lockCustomer(client, affiliate.id);
        const row = (await client.query(`
            INSERT INTO affiliate_credit_ledger(
                customer_id,currency,amount_minor,entry_type,state,reference_id,note,metadata
            ) VALUES($1,'GBP',-1000,'redeemed','available',$2,'hard-delete invariant spend','{}'::jsonb)
            RETURNING *
        `, [affiliate.id, unique('spend')])).rows[0];
        await serviceCreditAccounting.allocateOneDebit(client, row);
        return row;
    });

    assert.strictEqual((await balance(affiliate.id)).available_minor, 1500, 'pre-delete affiliate balance is wrong');
    const allocatedBefore = (await query(`SELECT COALESCE(SUM(amount_minor),0)::int AS amount FROM affiliate_credit_allocations WHERE debit_ledger_id=$1 AND grant_ledger_id=$2`, [debit.id, grant.id])).rows[0];
    assert.strictEqual(Number(allocatedBefore.amount), 1000, 'pre-delete spend allocation is missing');

    const job = await customerDeletion.enqueueHardDelete(referred.id, { reason: 'Residual temporal invariant DB smoke' });
    await query(`
        UPDATE customer_deletion_jobs
        SET status='running',targets_persisted_at=NOW(),jellyfin_results='[]'::jsonb,updated_at=NOW()
        WHERE id=$1
    `, [job.id]);
    await query('SELECT public.finalize_customer_deletion($1)', [job.id]);

    assert.strictEqual((await query('SELECT 1 FROM customers WHERE id=$1', [referred.id])).rowCount, 0, 'referred customer was not finalized');
    const survivingGrant = (await query('SELECT * FROM affiliate_credit_ledger WHERE id=$1', [grant.id])).rows[0];
    assert(survivingGrant, 'hard deletion destroyed another customer\'s affiliate grant');
    assert.strictEqual(survivingGrant.referred_customer_id, null, 'deleted personal identity was not detached from financial history');
    assert.strictEqual(Number(survivingGrant.amount_minor), 2500, 'affiliate grant value changed during referred-customer deletion');
    const allocatedAfter = (await query(`SELECT COALESCE(SUM(amount_minor),0)::int AS amount FROM affiliate_credit_allocations WHERE debit_ledger_id=$1 AND grant_ledger_id=$2`, [debit.id, grant.id])).rows[0];
    assert.strictEqual(Number(allocatedAfter.amount), 1000, 'hard deletion destroyed the grant/debit allocation');
    const after = await balance(affiliate.id);
    assert.strictEqual(after.available_minor, 1500, 'hard deletion corrupted the affiliate\'s spendable balance');
    assert.strictEqual(after.recoverable_minor, 0, 'hard deletion invented recoverable affiliate debt');

    return { affiliateId: affiliate.id, deletionJobId: job.id };
}

async function capacitySettlementInvariant() {
    // server_class is schema-constrained. Isolate this test with explicit plan/server
    // eligibility rather than inventing a synthetic class name.
    const capacityClass = 'custom';
    const plan = (await query(`
        INSERT INTO plans(
            code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,
            capacity_limit,visible,active,streams,server_class
        ) VALUES($1,$2,'jellyfin','direct','month',30,1000,'GBP',1,TRUE,TRUE,1,$3)
        RETURNING *
    `, [unique('capacity-plan'), `Capacity settlement ${suffix}`, capacityClass])).rows[0];
    const server = await jellyfinServer(capacityClass, 1, 'capacity-server');
    await query(`INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)`, [plan.id, server.id]);
    const lateCustomer = await customer('late-settlement');
    const occupyingCustomer = await customer('occupying-customer');
    const snapshot = {
        kind: 'direct_plan',
        provider: 'stripe',
        planId: plan.id,
        planPriceId: null,
        planCode: plan.code,
        planName: plan.name,
        priceMinor: 1000,
        discountedMinor: 1000,
        currency: 'GBP',
        billingInterval: 'month',
        durationDays: 30,
        checkoutMode: 'payment',
        providerMappingId: null,
        providerMappingRecordId: null,
        streams: 1,
        stremioHouseholdNetworkLimit: 1,
        serverClass: capacityClass
    };

    const intent = await checkoutIntents.createIntent({
        scope: 'customer',
        customerId: lateCustomer.id,
        planId: plan.id,
        provider: 'stripe',
        checkoutMode: 'payment',
        ttlMinutes: 5,
        commercialSnapshot: snapshot
    });
    const providerCheckoutId = `cs_capacity_${suffix}`;
    await checkoutIntents.attachProviderCheckout(intent.id, providerCheckoutId);
    await query(`UPDATE billing_checkout_intents SET state='expired',expires_at=NOW()-INTERVAL '1 minute',updated_at=NOW() WHERE id=$1`, [intent.id]);

    const occupyingSubscription = (await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','admin_grant',NOW(),NOW()+INTERVAL '30 days')
        RETURNING *
    `, [occupyingCustomer.id, plan.id])).rows[0];

    const providerPaymentId = `pi_capacity_${suffix}`;
    let capacityError = null;
    try {
        await lifecycle.activatePurchase({
            customerId: lateCustomer.id,
            planId: plan.id,
            provider: 'stripe',
            providerSubscriptionId: providerPaymentId,
            providerStatus: 'active',
            commercialSnapshot: { ...snapshot, checkoutIntentId: intent.id }
        });
    } catch (error) {
        capacityError = error;
    }
    assert(capacityError, 'late provider settlement overbooked a full server user pool');
    assert.strictEqual(capacityError.code, 'PLAN_CAPACITY_EXHAUSTED', `unexpected settlement failure: ${capacityError.message}`);
    assert.strictEqual(capacityError.paidButUnfulfilled, true, 'paid-but-unfulfilled state was not surfaced to the provider event owner');
    assert.strictEqual((await query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND source='stripe' AND provider_subscription_id=$2`, [lateCustomer.id, providerPaymentId])).rowCount, 0, 'capacity failure still created access');

    const openIncident = (await query(`
        SELECT * FROM payment_incidents
        WHERE provider='stripe' AND provider_case_id=$1 AND incident_type='checkout_completion'
        ORDER BY created_at DESC LIMIT 1
    `, [intent.id])).rows[0];
    assert(openIncident, 'paid provider settlement without capacity has no durable incident');
    assert.strictEqual(openIncident.incident_status, 'open', 'paid-but-unfulfilled incident was not left actionable');
    assert.strictEqual(openIncident.metadata?.paidButUnfulfilled, true, 'paid-but-unfulfilled metadata is missing');

    await query('DELETE FROM subscriptions WHERE id=$1', [occupyingSubscription.id]);
    const recovered = await lifecycle.activatePurchase({
        customerId: lateCustomer.id,
        planId: plan.id,
        provider: 'stripe',
        providerSubscriptionId: providerPaymentId,
        providerStatus: 'active',
        commercialSnapshot: { ...snapshot, checkoutIntentId: intent.id }
    });
    assert(recovered?.id, 'provider settlement did not converge after one server user place became available');
    await checkoutIntents.completeVerifiedProvider('stripe', providerCheckoutId, 'completed');
    const recoveredIncident = (await query('SELECT incident_status,resolved_at FROM payment_incidents WHERE id=$1', [openIncident.id])).rows[0];
    assert.strictEqual(recoveredIncident.incident_status, 'resolved', 'capacity incident did not settle after successful retry');
    assert(recoveredIncident.resolved_at, 'resolved capacity incident is missing its resolution timestamp');
    const finalSubscriptions = await query(`SELECT id FROM subscriptions WHERE plan_id=$1 AND superseded_by IS NULL AND status IN ('active','trialing','past_due','paused') AND current_period_end>NOW()`, [plan.id]);
    assert.strictEqual(finalSubscriptions.rowCount, 1, 'capacity recovery created more than one live occupant');

    return { planId: plan.id, serverId: server.id, customerIds: [lateCustomer.id, occupyingCustomer.id], incidentId: openIncident.id };
}

function replaySnapshot(plan, priceId) {
    return {
        kind: 'direct_plan',
        provider: 'stripe',
        planId: plan.id,
        planPriceId: null,
        planCode: plan.code,
        planName: plan.name,
        priceMinor: Number(plan.price_minor),
        discountedMinor: Number(plan.price_minor),
        currency: 'GBP',
        billingInterval: 'month',
        durationDays: 30,
        checkoutMode: 'subscription',
        providerMappingId: priceId,
        providerMappingRecordId: null,
        streams: 1,
        serverClass: plan.server_class
    };
}

async function historicalCheckoutReplayInvariant() {
    const planA = (await query(`
        INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,visible,active,streams,server_class)
        VALUES($1,$2,'jellyfin','direct','month',30,900,'GBP',TRUE,TRUE,1,'custom') RETURNING *
    `, [unique('replay-plan-a'), `Replay plan A ${suffix}`])).rows[0];
    const planB = (await query(`
        INSERT INTO plans(code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,visible,active,streams,server_class)
        VALUES($1,$2,'jellyfin','direct','month',30,1500,'GBP',TRUE,TRUE,1,'custom') RETURNING *
    `, [unique('replay-plan-b'), `Replay plan B ${suffix}`])).rows[0];
    const server = await jellyfinServer('custom', 100, 'replay-server');
    const replayCustomer = await customer('historical-replay');
    const providerSubscriptionId = `sub_replay_${suffix}`;
    const priceA = `price_replay_a_${suffix}`;
    const priceB = `price_replay_b_${suffix}`;
    const currentProviderCustomerId = `cus_current_${suffix}`;
    const recoveryProviderCustomerId = `cus_recovery_${suffix}`;
    const snapshotA = replaySnapshot(planA, priceA);
    const oldIntent = await checkoutIntents.createIntent({
        scope: 'customer', customerId: replayCustomer.id, planId: planA.id, provider: 'stripe', checkoutMode: 'subscription', commercialSnapshot: snapshotA
    });
    const oldCheckoutId = `cs_replay_old_${suffix}`;
    await checkoutIntents.attachProviderCheckout(oldIntent.id, oldCheckoutId);
    await checkoutIntents.completeVerifiedProvider('stripe', oldCheckoutId, 'completed');

    const currentEnd = new Date(Date.now() + 60 * 86400000);
    const currentSnapshot = replaySnapshot(planB, priceB);
    const existing = (await query(`
        INSERT INTO subscriptions(
            customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,
            provider_customer_id,provider_subscription_id,provider_price_id_snapshot,
            plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,
            billing_interval_snapshot,duration_days_snapshot,commercial_snapshot
        ) VALUES($1,$2,'active','stripe',NOW()-INTERVAL '5 days',$3,FALSE,$4,$5,$6,$7,$8,$9,'GBP','month',30,$10::jsonb)
        RETURNING *
    `, [replayCustomer.id, planB.id, currentEnd, currentProviderCustomerId, providerSubscriptionId, priceB, planB.name, planB.code, Number(planB.price_minor), JSON.stringify(currentSnapshot)])).rows[0];
    const initialPaymentCustomer = (await query(`SELECT * FROM payment_customers WHERE customer_id=$1 AND provider='stripe'`, [replayCustomer.id])).rows[0];
    assert(initialPaymentCustomer, 'subscription/payment-customer synchronization did not create the current provider identity');
    assert.strictEqual(initialPaymentCustomer.provider_customer_id, currentProviderCustomerId, 'pre-replay provider-customer mapping is wrong');

    const replayed = await lifecycle.activatePurchase({
        customerId: replayCustomer.id,
        planId: planA.id,
        provider: 'stripe',
        providerCustomerId: `cus_old_${suffix}`,
        providerSubscriptionId,
        providerStatus: 'past_due',
        periodStart: new Date(Date.now() - 90 * 86400000),
        periodEnd: new Date(Date.now() - 60 * 86400000),
        cancelAtPeriodEnd: true,
        commercialSnapshot: { ...snapshotA, checkoutIntentId: oldIntent.id }
    });
    assert.strictEqual(String(replayed.id), String(existing.id), 'historical replay created a duplicate provider subscription');
    const afterReplay = (await query('SELECT * FROM subscriptions WHERE id=$1', [existing.id])).rows[0];
    assert.strictEqual(String(afterReplay.plan_id), String(planB.id), 'completed historical checkout replay reverted the current plan');
    assert.strictEqual(afterReplay.status, 'active', 'completed historical checkout replay regressed current provider status');
    assert.strictEqual(afterReplay.cancel_at_period_end, false, 'completed historical checkout replay regressed renewal state');
    assert.strictEqual(afterReplay.provider_customer_id, currentProviderCustomerId, 'completed historical checkout replay regressed provider-customer identity');
    assert.strictEqual(afterReplay.provider_price_id_snapshot, priceB, 'completed historical checkout replay regressed provider price snapshot');
    assert.strictEqual(afterReplay.plan_code_snapshot, planB.code, 'completed historical checkout replay regressed commercial snapshot');
    assert.strictEqual(new Date(afterReplay.current_period_end).toISOString(), currentEnd.toISOString(), 'completed historical checkout replay regressed paid-through time');
    const paymentCustomerAfterReplay = (await query(`SELECT * FROM payment_customers WHERE customer_id=$1 AND provider='stripe'`, [replayCustomer.id])).rows[0];
    assert(paymentCustomerAfterReplay, 'historical replay removed the current provider-customer mapping');
    assert.strictEqual(paymentCustomerAfterReplay.provider_customer_id, currentProviderCustomerId, 'historical replay replaced the current provider-customer mapping with stale checkout identity');

    const openIntent = await checkoutIntents.createIntent({
        scope: 'customer', customerId: replayCustomer.id, planId: planA.id, provider: 'stripe', checkoutMode: 'subscription', commercialSnapshot: snapshotA
    });
    const openCheckoutId = `cs_replay_open_${suffix}`;
    await checkoutIntents.attachProviderCheckout(openIntent.id, openCheckoutId);
    const recoveredEnd = new Date(Date.now() + 30 * 86400000);
    await lifecycle.activatePurchase({
        customerId: replayCustomer.id,
        planId: planA.id,
        provider: 'stripe',
        providerCustomerId: recoveryProviderCustomerId,
        providerSubscriptionId,
        providerStatus: 'active',
        periodEnd: recoveredEnd,
        commercialSnapshot: { ...snapshotA, checkoutIntentId: openIntent.id }
    });
    const afterOpenRecovery = (await query('SELECT * FROM subscriptions WHERE id=$1', [existing.id])).rows[0];
    assert.strictEqual(String(afterOpenRecovery.plan_id), String(planA.id), 'open checkout crash-recovery path was incorrectly blocked by replay protection');
    assert.strictEqual(afterOpenRecovery.provider_price_id_snapshot, priceA, 'open checkout recovery did not restore its verified provider price snapshot');
    assert.strictEqual(afterOpenRecovery.plan_code_snapshot, planA.code, 'open checkout recovery did not restore its verified commercial snapshot');
    assert.strictEqual(afterOpenRecovery.provider_customer_id, recoveryProviderCustomerId, 'open checkout recovery did not update the subscription provider-customer identity');
    const paymentCustomerAfterRecovery = (await query(`SELECT * FROM payment_customers WHERE customer_id=$1 AND provider='stripe'`, [replayCustomer.id])).rows[0];
    assert(paymentCustomerAfterRecovery, 'open checkout recovery lost the provider-customer mapping');
    assert.strictEqual(paymentCustomerAfterRecovery.provider_customer_id, recoveryProviderCustomerId, 'open checkout recovery did not converge the provider-customer mapping');

    return { customerId: replayCustomer.id, planIds: [planA.id, planB.id], serverId: server.id };
}

async function main() {
    const cleanup = { customerIds: [], planIds: [], serverIds: [], jobIds: [] };
    try {
        const affiliate = await affiliateDeletionInvariant();
        cleanup.customerIds.push(affiliate.affiliateId);
        cleanup.jobIds.push(affiliate.deletionJobId);

        const capacity = await capacitySettlementInvariant();
        cleanup.customerIds.push(...capacity.customerIds);
        cleanup.planIds.push(capacity.planId);
        cleanup.serverIds.push(capacity.serverId);

        const replay = await historicalCheckoutReplayInvariant();
        cleanup.customerIds.push(replay.customerId);
        cleanup.planIds.push(...replay.planIds);
        cleanup.serverIds.push(replay.serverId);

        console.log('Residual temporal invariant DB smoke passed: affiliate deletion + late settlement user capacity + historical checkout replay.');
    } finally {
        for (const customerId of cleanup.customerIds) {
            await query('DELETE FROM payment_incidents WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM billing_checkout_intents WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM subscriptions WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM payment_customers WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        }
        for (const planId of cleanup.planIds) {
            await query('DELETE FROM plan_server_eligibility WHERE plan_id=$1', [planId]).catch(() => {});
            await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
        }
        for (const serverId of cleanup.serverIds) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
        for (const jobId of cleanup.jobIds) await query('DELETE FROM customer_deletion_jobs WHERE id=$1', [jobId]).catch(() => {});
        await getPool().end();
    }
}

main().catch(async error => {
    console.error(error.stack || error);
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});