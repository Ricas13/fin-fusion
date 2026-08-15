'use strict';

const { query, transaction } = require('../db');
const { reconcileCustomer } = require('../jellyfin/resilient-provisioning');
const discounts = require('./discounts');
const referrals = require('../referrals');

const PAYMENT_EVENT_LEASE_MINUTES = 30;

function addPlanDuration(plan, from = new Date()) {
    const days = Number(plan.duration_days || plan.durationDays || 30);
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

async function getProviderOptions(planCode, provider) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p
        JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND p.active=TRUE AND p.visible=TRUE
          AND pp.provider=$2 AND pp.active=TRUE
        ORDER BY CASE pp.checkout_mode WHEN 'payment' THEN 0 ELSE 1 END
    `, [planCode, provider]);
    return result.rows;
}

async function getProviderPlan(planCode, provider, checkoutMode = null) {
    const mode = checkoutMode && ['payment','subscription'].includes(checkoutMode) ? checkoutMode : null;
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p
        JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND p.active=TRUE AND p.visible=TRUE
          AND pp.provider=$2 AND pp.active=TRUE
          AND ($3::text IS NULL OR pp.checkout_mode=$3)
        ORDER BY CASE pp.checkout_mode WHEN 'payment' THEN 0 ELSE 1 END
        LIMIT 1
    `, [planCode, provider, mode]);
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
        INSERT INTO payment_events(
            provider,provider_event_id,event_type,payload,processing_started_at,processing_token
        )
        VALUES($1,$2,$3,$4::jsonb,NOW(),gen_random_uuid())
        ON CONFLICT(provider,provider_event_id)
        DO UPDATE SET event_type=EXCLUDED.event_type,
                      payload=EXCLUDED.payload,
                      processing_error=NULL,
                      processing_started_at=NOW(),
                      processing_token=gen_random_uuid()
        WHERE payment_events.processed_at IS NULL
          AND (
              payment_events.processing_started_at IS NULL
              OR payment_events.processing_started_at < NOW() - ($5::int * INTERVAL '1 minute')
          )
        RETURNING id,processing_token,processing_started_at
    `, [provider, eventId, eventType, JSON.stringify(payload), PAYMENT_EVENT_LEASE_MINUTES]);
    return result.rows[0] || null;
}

async function finishPaymentEvent(eventRow, error = null) {
    if (!eventRow?.id || !eventRow?.processing_token) return false;
    const result = await query(`
        UPDATE payment_events
        SET processed_at=CASE WHEN $3::text IS NULL THEN NOW() ELSE NULL END,
            processing_error=$3,
            processing_started_at=NULL,
            processing_token=NULL
        WHERE id=$1 AND processing_token=$2
        RETURNING id
    `, [eventRow.id, eventRow.processing_token, error ? String(error.message || error).slice(0, 4000) : null]);
    return result.rowCount === 1;
}

async function startFreeTrial(customerId, planCode = null) {
    const requestedCode = String(planCode || '').trim() || null;
    const subscription = await transaction(async client => {
        const prior = await client.query(`
            SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=$1 AND p.billing_interval='trial' LIMIT 1
        `, [customerId]);
        if (prior.rowCount) throw new Error('This account has already used its free trial');

        const planResult = await client.query(`
            SELECT * FROM plans
            WHERE billing_interval='trial'
              AND active=TRUE AND visible=TRUE
              AND audience IN ('direct','both')
              AND ($1::text IS NULL OR code=$1)
            ORDER BY sort_order,price_minor,name
            LIMIT 1
        `, [requestedCode]);
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

async function claimFreePlan(customerId, planCode) {
    const subscription = await transaction(async client => {
        const planResult = await client.query(`
            SELECT * FROM plans
            WHERE code=$1 AND active=TRUE AND visible=TRUE AND price_minor=0 AND billing_interval<>'trial'
            LIMIT 1
        `, [planCode]);
        if (!planResult.rowCount) throw new Error('This free plan is not available');
        const plan = planResult.rows[0];

        const active = await client.query(`
            SELECT 1 FROM subscriptions
            WHERE customer_id=$1 AND plan_id=$2 AND status IN ('active','trialing')
            LIMIT 1
        `, [customerId, plan.id]);
        if (active.rowCount) throw new Error('You already have free access on this plan');

        const startsAt = new Date();
        const endsAt = addPlanDuration(plan, startsAt);
        const created = await client.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active','free_claim',$3,$4)
            RETURNING *
        `, [customerId, plan.id, startsAt, endsAt]);
        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('subscription.free.claim','subscription',$1,$2::jsonb)
        `, [created.rows[0].id, JSON.stringify({ customerId, planCode: plan.code })]);
        return created.rows[0];
    });
    await reconcileCustomer(customerId);
    return subscription;
}

function purchaseSnapshot(snapshot, { provider, planId }) {
    if (!snapshot) return null;
    if (typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid checkout commercial snapshot');
    if (snapshot.kind !== 'direct_plan') throw new Error('Unsupported checkout commercial snapshot');
    if (String(snapshot.planId || '') !== String(planId)) throw new Error('Checkout contract plan does not match activation plan');
    if (snapshot.provider !== provider) throw new Error('Checkout contract provider does not match activation provider');
    const durationDays = Number(snapshot.durationDays);
    const priceMinor = Number(snapshot.priceMinor);
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) throw new Error('Checkout contract duration is invalid');
    if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new Error('Checkout contract price is invalid');
    return { ...snapshot, durationDays, priceMinor };
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
    cancelAtPeriodEnd = false,
    discountCodeId = null,
    discountAmountAppliedMinor = 0,
    commercialSnapshot = null
}) {
    if (!['stripe', 'paypal'].includes(provider)) throw new Error('Unsupported payment provider');
    if (!providerSubscriptionId) throw new Error('Provider subscription/payment ID is required');
    const contract = purchaseSnapshot(commercialSnapshot, { provider, planId });

    const subscription = await transaction(async client => {
        // New checkout activation uses the provider-verified commercial contract;
        // provider renewals without a checkout snapshot preserve the snapshot
        // already stored on the subscription.
        const planResult = await client.query('SELECT * FROM plans WHERE id=$1', [planId]);
        if (!planResult.rowCount) throw new Error('Plan not found');
        const plan = planResult.rows[0];
        const priceMap = contract?.providerMappingId
            ? { rows: [{ external_id: contract.providerMappingId }] }
            : await client.query(`SELECT external_id FROM plan_provider_prices
                WHERE plan_id=$1 AND provider=$2 ORDER BY active DESC,updated_at DESC LIMIT 1`, [planId, provider]);
        const providerPriceId = priceMap.rows[0]?.external_id || null;
        const startsAt = periodStart ? new Date(periodStart) : new Date();
        const endsAt = periodEnd ? new Date(periodEnd) : addPlanDuration(contract || plan, startsAt);
        const status = mapProviderStatus(provider, providerStatus);

        const existing = await client.query(`
            SELECT * FROM subscriptions
            WHERE source=$1 AND provider_subscription_id=$2
            LIMIT 1 FOR UPDATE
        `, [provider, providerSubscriptionId]);

        const snapshotJson = contract ? JSON.stringify(contract) : null;
        const planNameSnapshot = contract?.planName || plan.name;
        const planCodeSnapshot = contract?.planCode || plan.code;
        const priceMinorSnapshot = contract?.priceMinor ?? plan.price_minor;
        const currencySnapshot = String(contract?.currency || plan.currency || '').toUpperCase();
        const billingIntervalSnapshot = contract?.billingInterval || plan.billing_interval;
        const durationDaysSnapshot = contract?.durationDays ?? plan.duration_days;
        let row;
        if (existing.rowCount) {
            const updated = await client.query(`
                UPDATE subscriptions
                SET customer_id=$1,plan_id=$2,status=$3,starts_at=$4,current_period_end=$5,
                    cancel_at_period_end=$6,provider_customer_id=COALESCE($7,provider_customer_id),
                    provider_price_id_snapshot=COALESCE($8,provider_price_id_snapshot),
                    plan_name_snapshot=CASE WHEN $9::jsonb IS NULL THEN plan_name_snapshot ELSE $10 END,
                    plan_code_snapshot=CASE WHEN $9::jsonb IS NULL THEN plan_code_snapshot ELSE $11 END,
                    price_minor_snapshot=CASE WHEN $9::jsonb IS NULL THEN price_minor_snapshot ELSE $12 END,
                    currency_snapshot=CASE WHEN $9::jsonb IS NULL THEN currency_snapshot ELSE $13 END,
                    billing_interval_snapshot=CASE WHEN $9::jsonb IS NULL THEN billing_interval_snapshot ELSE $14 END,
                    duration_days_snapshot=CASE WHEN $9::jsonb IS NULL THEN duration_days_snapshot ELSE $15 END,
                    commercial_snapshot=CASE WHEN $9::jsonb IS NULL THEN commercial_snapshot ELSE $9::jsonb END,
                    updated_at=NOW()
                WHERE id=$16 RETURNING *
            `, [customerId, planId, status, startsAt, endsAt, cancelAtPeriodEnd, providerCustomerId, providerPriceId, snapshotJson, planNameSnapshot, planCodeSnapshot, priceMinorSnapshot, currencySnapshot, billingIntervalSnapshot, durationDaysSnapshot, existing.rows[0].id]);
            row = updated.rows[0];
        } else {
            const inserted = await client.query(`
                INSERT INTO subscriptions(
                    customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,
                    provider_customer_id,provider_subscription_id,provider_price_id_snapshot,
                    plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,
                    billing_interval_snapshot,duration_days_snapshot,commercial_snapshot
                ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17::jsonb,'{}'::jsonb))
                RETURNING *
            `, [customerId, planId, status, provider, startsAt, endsAt, cancelAtPeriodEnd, providerCustomerId, providerSubscriptionId, providerPriceId, planNameSnapshot, planCodeSnapshot, priceMinorSnapshot, currencySnapshot, billingIntervalSnapshot, durationDaysSnapshot, snapshotJson]);
            row = inserted.rows[0];
        }

        const effectiveDiscountCodeId = discountCodeId || contract?.discountCodeId || null;
        const appliedMinor = contract
            ? Math.max(0, Number(contract.priceMinor || 0) - Number(contract.discountedMinor ?? contract.priceMinor || 0))
            : discountAmountAppliedMinor;
        if (effectiveDiscountCodeId) {
            await client.query('SAVEPOINT discount_redemption');
            try {
                await discounts.redeemForSubscriptionTx(client, {
                    discountCodeId: effectiveDiscountCodeId, customerId, subscriptionId: row.id, amountAppliedMinor: appliedMinor
                });
                await client.query('RELEASE SAVEPOINT discount_redemption');
            } catch (error) {
                console.error('Discount redemption bookkeeping failed; subscription is still being activated:', error.message);
                await client.query('ROLLBACK TO SAVEPOINT discount_redemption');
            }
        }

        await client.query(`
            INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('payment.subscription.activate','subscription',$1,$2::jsonb)
        `, [row.id, JSON.stringify({ provider, customerId, planId, providerSubscriptionId, providerPriceId, status, checkoutContract: Boolean(contract) })]);
        return row;
    });

    if (providerCustomerId) await ensurePaymentCustomer({ customerId, provider, providerCustomerId });
    await reconcileCustomer(customerId);
    try {
        await referrals.rewardIfQualifying(customerId);
    } catch (error) {
        console.error('Referral reward check failed:', error.message);
    }
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
    PAYMENT_EVENT_LEASE_MINUTES,
    addPlanDuration,
    mapProviderStatus,
    getProviderOptions,
    getProviderPlan,
    getProviderPlanByExternalId,
    ensurePaymentCustomer,
    findPaymentCustomer,
    beginPaymentEvent,
    finishPaymentEvent,
    startFreeTrial,
    claimFreePlan,
    purchaseSnapshot,
    activatePurchase,
    updateProviderSubscription
};
