'use strict';

const { query, transaction } = require('../db');
const { reconcileCustomer } = require('../jellyfin/provisioning');

function addPlanDuration(plan, from = new Date()) {
    const days = Number(plan.duration_days || 30);
    return new Date(from.getTime() + days * 86400000);
}

function mapProviderStatus(provider, status) {
    const value = String(status || '').toLowerCase();
    if (provider === 'stripe') {
        if (['active', 'trialing'].includes(value)) return value;
        if (['past_due', 'unpaid', 'incomplete'].includes(value)) return 'past_due';
        if (['paused'].includes(value)) return 'paused';
        if (['canceled', 'cancelled', 'incomplete_expired'].includes(value)) return 'cancelled';
    }
    if (provider === 'paypal') {
        if (value === 'active') return 'active';
        if (['approval_pending', 'approved'].includes(value)) return 'trialing';
        if (['suspended'].includes(value)) return 'paused';
        if (['cancelled', 'canceled'].includes(value)) return 'cancelled';
        if (['expired'].includes(value)) return 'expired';
    }
    return 'past_due';
}

async function getProviderPlan(planCode, provider) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p
        JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND p.active=TRUE AND p.visible=TRUE
          AND pp.provider=$2 AND pp.active=TRUE
        LIMIT 1
    `, [planCode, provider]);
    return result.rows[0] || null;
}

async function getProviderPlanByExternalId(provider, externalId) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id
        WHERE pp.provider=$1 AND pp.external_id=$2 AND pp.active=TRUE
        LIMIT 1
    `, [provider, externalId]);
    return result.rows[0] || null;
}

async function ensurePaymentCustomer({ customerId, provider, providerCustomerId }) {
    if (!providerCustomerId) return null;
    const result = await query(`
        INSERT INTO payment_customers(customer_id,provider,provider_customer_id)
        VALUES($1,$2,$3)
        ON CONFLICT(customer_id,provider)
        DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id,updated_at=NOW()
        RETURNING *
    `, [customerId, provider, providerCustomerId]);
    return result.rows[0];
}

async function findPaymentCustomer(customerId, provider) {
    const result = await query(`
        SELECT * FROM payment_customers WHERE customer_id=$1 AND provider=$2 LIMIT 1
    `, [customerId, provider]);
    return result.rows[0] || null;
}

async function beginPaymentEvent({ provider, eventId, eventType, payload }) {
    const result = await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload)
        VALUES($1,$2,$3,$4::jsonb)
        ON CONFLICT(provider,provider_event_id) DO NOTHING
        RETURNING id
    `, [provider, eventId, eventType, JSON.stringify(payload)]);
    return result.rows[0] || null;
}

async function finishPaymentEvent(eventRow, error = null) {
    if (!eventRow) return;
    await query(`
        UPDATE payment_events
        SET processed_at=CASE WHEN $2::text IS NULL THEN NOW() ELSE processed_at END,
            processing_error=$2
        WHERE id=$1
    `, [eventRow.id, error ? String(error.message || error).slice(0, 4000) : null]);
}

async function startFreeTrial(customerId) {
    const subscription = await transaction(async client => {
        const prior = await client.query(`
            SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=$1 AND p.billing_interval='trial' LIMIT 1
        `, [customerId]);
        if (prior.rowCount) throw new Error('This account has already used its free trial');

        const planResult = await client.query(`
            SELECT * FROM plans
            WHERE code='trial-24h' AND active=TRUE AND visible=TRUE
            LIMIT 1
        `);
        if (!planResult.rowCount) throw new Error('Free trial is not available');
        const plan = planResult.rows[0];
        const startsAt = new Date();
        const endsAt = addPlanDuration(plan, startsAt);
        const created = await client.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'trialing','manual',$3,$4)
            RETURNING *
        `, [customerId, plan.id, startsAt, endsAt]);
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('subscription.trial.start','subscription',$1,$2::jsonb)
        `, [created.rows[0].id, JSON.stringify({ customerId, planCode: plan.code })]);
        return created.rows[0];
    });
    await reconcileCustomer(customerId);
    return subscription;
}

async function activatePurchase({
    customerId,
    planId,
    provider,
    providerCustomerId = null,
    providerSubscriptionId,
    providerStatus = 'active',
    periodStart = null,
    periodEnd = null,
    cancelAtPeriodEnd = false
}) {
    if (!['stripe', 'paypal'].includes(provider)) throw new Error('Unsupported payment provider');
    if (!providerSubscriptionId) throw new Error('Provider subscription/payment ID is required');

    const subscription = await transaction(async client => {
        const planResult = await client.query('SELECT * FROM plans WHERE id=$1 AND active=TRUE', [planId]);
        if (!planResult.rowCount) throw new Error('Plan not found');
        const plan = planResult.rows[0];
        const startsAt = periodStart ? new Date(periodStart) : new Date();
        const endsAt = periodEnd ? new Date(periodEnd) : addPlanDuration(plan, startsAt);
        const status = mapProviderStatus(provider, providerStatus);

        const existing = await client.query(`
            SELECT * FROM subscriptions
            WHERE source=$1 AND provider_subscription_id=$2
            LIMIT 1 FOR UPDATE
        `, [provider, providerSubscriptionId]);

        let row;
        if (existing.rowCount) {
            const updated = await client.query(`
                UPDATE subscriptions
                SET customer_id=$1,plan_id=$2,status=$3,starts_at=$4,current_period_end=$5,
                    cancel_at_period_end=$6,provider_customer_id=COALESCE($7,provider_customer_id),updated_at=NOW()
                WHERE id=$8 RETURNING *
            `, [customerId, planId, status, startsAt, endsAt, cancelAtPeriodEnd, providerCustomerId, existing.rows[0].id]);
            row = updated.rows[0];
        } else {
            const inserted = await client.query(`
                INSERT INTO subscriptions(
                    customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,
                    provider_customer_id,provider_subscription_id
                ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)
                RETURNING *
            `, [customerId, planId, status, provider, startsAt, endsAt, cancelAtPeriodEnd, providerCustomerId, providerSubscriptionId]);
            row = inserted.rows[0];
        }

        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('payment.subscription.activate','subscription',$1,$2::jsonb)
        `, [row.id, JSON.stringify({ provider, customerId, planId, providerSubscriptionId, status })]);
        return row;
    });

    if (providerCustomerId) await ensurePaymentCustomer({ customerId, provider, providerCustomerId });
    await reconcileCustomer(customerId);
    return subscription;
}

async function updateProviderSubscription({ provider, providerSubscriptionId, providerStatus, periodEnd = null, cancelAtPeriodEnd = null }) {
    const status = mapProviderStatus(provider, providerStatus);
    const result = await query(`
        UPDATE subscriptions
        SET status=$1,
            current_period_end=COALESCE($2,current_period_end),
            cancel_at_period_end=COALESCE($3,cancel_at_period_end),
            updated_at=NOW()
        WHERE source=$4 AND provider_subscription_id=$5
        RETURNING *
    `, [status, periodEnd ? new Date(periodEnd) : null, cancelAtPeriodEnd, provider, providerSubscriptionId]);
    if (result.rowCount) await reconcileCustomer(result.rows[0].customer_id);
    return result.rows[0] || null;
}

module.exports = {
    addPlanDuration,
    mapProviderStatus,
    getProviderPlan,
    getProviderPlanByExternalId,
    ensurePaymentCustomer,
    findPaymentCustomer,
    beginPaymentEvent,
    finishPaymentEvent,
    startFreeTrial,
    activatePurchase,
    updateProviderSubscription
};
