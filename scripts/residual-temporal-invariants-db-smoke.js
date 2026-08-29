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
    const plan = (await query(`
        INSERT INTO plans(
            code,name,service_type,audience,billing_interval,duration_days,price_minor,currency,
            capacity_limit,visible,active,streams,server_class
        ) VALUES($1,$2,'jellyfin','direct','month',30,1000,'GBP',1,TRUE,TRUE,1,'custom')
        RETURNING *
    `, [unique('capacity-plan'), `Capacity settlement ${suffix}`])).rows[0];
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
        stremioHouseholdNetworkLimit: 1
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
    assert(capacityError, 'late provider settlement overbooked a full plan');
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
    assert(recovered?.id, 'provider settlement did not converge after capacity became available');
    await checkoutIntents.completeVerifiedProvider('stripe', providerCheckoutId, 'completed');
    const recoveredIncident = (await query('SELECT incident_status,resolved_at FROM payment_incidents WHERE id=$1', [openIncident.id])).rows[0];
    assert.strictEqual(recoveredIncident.incident_status, 'resolved', 'capacity incident did not settle after successful retry');
    assert(recoveredIncident.resolved_at, 'resolved capacity incident is missing its resolution timestamp');
    const finalSubscriptions = await query(`SELECT id FROM subscriptions WHERE plan_id=$1 AND superseded_by IS NULL AND status IN ('active','trialing','past_due','paused') AND current_period_end>NOW()`, [plan.id]);
    assert.strictEqual(finalSubscriptions.rowCount, 1, 'capacity recovery created more than one live occupant');

    return { planId: plan.id, customerIds: [lateCustomer.id, occupyingCustomer.id], incidentId: openIncident.id };
}

async function main() {
    const cleanup = { customerIds: [], planIds: [], jobIds: [] };
    try {
        const affiliate = await affiliateDeletionInvariant();
        cleanup.customerIds.push(affiliate.affiliateId);
        cleanup.jobIds.push(affiliate.deletionJobId);

        const capacity = await capacitySettlementInvariant();
        cleanup.customerIds.push(...capacity.customerIds);
        cleanup.planIds.push(capacity.planId);

        console.log('Residual temporal invariant DB smoke passed: affiliate deletion + late settlement capacity.');
    } finally {
        for (const customerId of cleanup.customerIds) {
            await query('DELETE FROM payment_incidents WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM billing_checkout_intents WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM subscriptions WHERE customer_id=$1', [customerId]).catch(() => {});
            await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        }
        for (const planId of cleanup.planIds) await query('DELETE FROM plans WHERE id=$1', [planId]).catch(() => {});
        for (const jobId of cleanup.jobIds) await query('DELETE FROM customer_deletion_jobs WHERE id=$1', [jobId]).catch(() => {});
        await getPool().end();
    }
}

main().catch(async error => {
    console.error(error.stack || error);
    try { await getPool().end(); } catch (_) {}
    process.exit(1);
});
