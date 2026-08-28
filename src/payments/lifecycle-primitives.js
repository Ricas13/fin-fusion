'use strict';

const { query, transaction } = require('../db');
const { reconcileCustomer } = require('../jellyfin/resilient-provisioning');
const accessHolds = require('../entitlements/access-holds');
const discounts = require('./discounts');
const referrals = require('../referrals');

const PAYMENT_EVENT_LEASE_MINUTES = 30;
const PAYMENT_EVENT_RETRY_MINUTES = 5;
const PAYMENT_DELINQUENCY_HOLD_TYPE = 'payment_delinquency';

function addCalendarMonths(from, months) {
    const start = new Date(from), result = new Date(start.getTime());
    if (!Number.isFinite(start.getTime())) return result;
    const originalDay = start.getUTCDate();
    const absoluteMonth = start.getUTCMonth() + Number(months);
    const targetYear = start.getUTCFullYear() + Math.floor(absoluteMonth / 12);
    const targetMonth = ((absoluteMonth % 12) + 12) % 12;
    const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
    result.setUTCFullYear(targetYear, targetMonth, Math.min(originalDay, lastDay));
    return result;
}

function addPlanDuration(plan, from = new Date()) {
    const interval = String(plan?.billing_interval || plan?.billingInterval || '').toLowerCase();
    if (interval === 'month') return addCalendarMonths(from, 1);
    if (interval === '6_months') return addCalendarMonths(from, 6);
    if (interval === 'year') return addCalendarMonths(from, 12);
    const days = Number(plan?.duration_days || plan?.durationDays || 30);
    return new Date(new Date(from).getTime() + days * 86400000);
}

function mapProviderStatus(provider, status) {
    const value = String(status || '').toLowerCase();
    if (provider === 'stripe') {
        if (['active', 'trialing'].includes(value)) return value;
        if (['past_due', 'unpaid', 'incomplete'].includes(value)) return 'past_due';
        if (value === 'paused') return 'paused';
        if (['canceled', 'cancelled', 'incomplete_expired'].includes(value)) return 'cancelled';
    }
    if (provider === 'paypal') {
        if (value === 'active') return 'active';
        if (['approval_pending', 'approved'].includes(value)) return 'trialing';
        if (value === 'suspended') return 'paused';
        if (['cancelled', 'canceled'].includes(value)) return 'cancelled';
        if (value === 'expired') return 'expired';
    }
    if (provider === 'plisio') {
        if (value === 'completed') return 'active';
        if (['new', 'pending', 'pending internal'].includes(value)) return 'past_due';
        if (['cancelled', 'cancelled duplicate', 'error', 'mismatch'].includes(value)) return 'cancelled';
        if (value === 'expired') return 'expired';
    }
    return null;
}

function paymentDelinquencySourceKey(provider, providerSubscriptionId) {
    const id = String(providerSubscriptionId || '').trim();
    if (provider === 'stripe' && /^sub_/i.test(id)) return `stripe:${id}`;
    if (provider === 'paypal' && /^I-/i.test(id)) return `paypal:${id}`;
    return null;
}

async function syncProviderAccessState({ customerId, provider, providerSubscriptionId, status }, client = null) {
    const sourceKey = paymentDelinquencySourceKey(provider, providerSubscriptionId);
    if (!customerId || !sourceKey || !status) return null;

    if (['past_due', 'paused'].includes(status)) {
        return accessHolds.addHold({
            customerId,
            type: PAYMENT_DELINQUENCY_HOLD_TYPE,
            sourceKey,
            reason: `${provider} recurring payment is delinquent`,
            metadata: { provider, providerSubscriptionId, status, automatic: true }
        }, client);
    }

    return accessHolds.releaseHold({
        customerId,
        type: PAYMENT_DELINQUENCY_HOLD_TYPE,
        sourceKey
    }, client);
}

async function reconcileCommittedCustomer(customerId, context = 'Entitlement') {
    try { return await reconcileCustomer(customerId); }
    catch (error) {
        console.error(`${context} provisioning pending for ${customerId}:`, error.message);
        return null;
    }
}

async function ensurePaymentCustomer({ customerId, provider, providerCustomerId }) {
    if (!providerCustomerId) return null;
    const result = await query(`INSERT INTO payment_customers(customer_id,provider,provider_customer_id) VALUES($1,$2,$3) ON CONFLICT(customer_id,provider) DO UPDATE SET provider_customer_id=EXCLUDED.provider_customer_id,updated_at=NOW() RETURNING *`, [customerId, provider, providerCustomerId]);
    return result.rows[0];
}

async function findPaymentCustomer(customerId, provider) {
    const result = await query(`SELECT * FROM payment_customers WHERE customer_id=$1 AND provider=$2 LIMIT 1`, [customerId, provider]);
    return result.rows[0] || null;
}

async function beginPaymentEvent({ provider, eventId, eventType, payload }) {
    const result = await query(`INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processing_started_at,processing_token) VALUES($1,$2,$3,$4::jsonb,NOW(),gen_random_uuid()) ON CONFLICT(provider,provider_event_id) DO UPDATE SET event_type=EXCLUDED.event_type,payload=EXCLUDED.payload,processing_error=NULL,processing_started_at=NOW(),processing_token=gen_random_uuid() WHERE payment_events.processed_at IS NULL AND (payment_events.processing_started_at IS NULL OR payment_events.processing_started_at < NOW() - ($5::int * INTERVAL '1 minute')) RETURNING id,provider,provider_event_id,event_type,payload,processing_token,processing_started_at`, [provider, eventId, eventType, JSON.stringify(payload), PAYMENT_EVENT_LEASE_MINUTES]);
    return result.rows[0] || null;
}

async function finishPaymentEvent(eventRow, error = null) {
    if (!eventRow?.id || !eventRow?.processing_token) return false;
    const failure = error ? String(error.message || error).slice(0, 4000) : null;
    const result = await query(`UPDATE payment_events SET processed_at=CASE WHEN $3::text IS NULL THEN NOW() ELSE NULL END,processing_error=$3,processing_started_at=CASE WHEN $3::text IS NULL THEN NULL ELSE NOW() END,processing_token=NULL WHERE id=$1 AND processing_token=$2 RETURNING id`, [eventRow.id, eventRow.processing_token, failure]);
    return result.rowCount === 1;
}

async function claimRetryablePaymentEvents({ limit = 25 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const result = await query(`
        WITH candidates AS (
            SELECT id
            FROM payment_events
            WHERE processed_at IS NULL
              AND (
                (processing_error IS NOT NULL AND processing_token IS NULL
                 AND (processing_started_at IS NULL OR processing_started_at < NOW() - ($2::int * INTERVAL '1 minute')))
                OR
                (processing_token IS NOT NULL AND processing_started_at < NOW() - ($3::int * INTERVAL '1 minute'))
              )
            ORDER BY created_at,id
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        UPDATE payment_events p
           SET processing_started_at=NOW(),processing_token=gen_random_uuid()
          FROM candidates c
         WHERE p.id=c.id
         RETURNING p.id,p.provider,p.provider_event_id,p.event_type,p.payload,p.processing_error,p.processing_started_at,p.processing_token
    `, [safeLimit, PAYMENT_EVENT_RETRY_MINUTES, PAYMENT_EVENT_LEASE_MINUTES]);
    return result.rows;
}

function purchaseSnapshot(snapshot, { provider, planId }) {
    if (!snapshot) return null;
    if (typeof snapshot !== 'object' || Array.isArray(snapshot)) throw new Error('Invalid checkout commercial snapshot');
    if (snapshot.kind !== 'direct_plan') throw new Error('Unsupported checkout commercial snapshot');
    if (String(snapshot.planId || '') !== String(planId)) throw new Error('Checkout contract plan does not match activation plan');
    if (snapshot.provider !== provider) throw new Error('Checkout contract provider does not match activation provider');
    const durationDays = Number(snapshot.durationDays), priceMinor = Number(snapshot.priceMinor);
    if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 3650) throw new Error('Checkout contract duration is invalid');
    if (!Number.isInteger(priceMinor) || priceMinor < 0) throw new Error('Checkout contract price is invalid');
    return { ...snapshot, durationDays, priceMinor };
}

async function activatePurchase({ customerId, planId, provider, providerCustomerId = null, providerSubscriptionId, providerStatus = 'active', periodStart = null, periodEnd = null, cancelAtPeriodEnd = false, discountCodeId = null, discountAmountAppliedMinor = 0, commercialSnapshot = null }) {
    if (!['stripe', 'paypal', 'plisio'].includes(provider)) throw new Error('Unsupported payment provider');
    if (!providerSubscriptionId) throw new Error('Provider subscription/payment ID is required');
    const contract = purchaseSnapshot(commercialSnapshot, { provider, planId });
    const subscription = await transaction(async client => {
        const planResult = await client.query('SELECT * FROM plans WHERE id=$1', [planId]);
        if (!planResult.rowCount) throw new Error('Plan not found');
        const plan = planResult.rows[0];
        const priceMap = contract?.providerMappingId
            ? { rows: [{ external_id: contract.providerMappingId }] }
            : await client.query(`SELECT external_id FROM plan_provider_prices WHERE plan_id=$1 AND provider=$2 ORDER BY active DESC,updated_at DESC LIMIT 1`, [planId, provider]);
        const providerPriceId = priceMap.rows[0]?.external_id || null;
        const startsAt = periodStart ? new Date(periodStart) : new Date();
        const endsAt = periodEnd ? new Date(periodEnd) : addPlanDuration(contract || plan, startsAt);
        const status = mapProviderStatus(provider, providerStatus);
        if (!status) throw new Error(`Unsupported ${provider} subscription status: ${String(providerStatus || 'unknown').slice(0, 120)}`);
        const existing = await client.query(`SELECT * FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 LIMIT 1 FOR UPDATE`, [provider, providerSubscriptionId]);
        const snapshotJson = contract ? JSON.stringify(contract) : null;
        const planNameSnapshot = contract?.planName || plan.name;
        const planCodeSnapshot = contract?.planCode || plan.code;
        const priceMinorSnapshot = contract?.priceMinor ?? plan.price_minor;
        const currencySnapshot = String(contract?.currency || plan.currency || '').toUpperCase();
        const billingIntervalSnapshot = contract?.billingInterval || plan.billing_interval;
        const durationDaysSnapshot = contract?.durationDays ?? plan.duration_days;
        let row;
        if (existing.rowCount) {
            const updated = await client.query(`UPDATE subscriptions SET customer_id=$1,plan_id=$2,status=$3,starts_at=$4,current_period_end=$5,cancel_at_period_end=$6,provider_customer_id=COALESCE($7,provider_customer_id),provider_price_id_snapshot=COALESCE($8,provider_price_id_snapshot),plan_name_snapshot=CASE WHEN $9::jsonb IS NULL THEN plan_name_snapshot ELSE $10 END,plan_code_snapshot=CASE WHEN $9::jsonb IS NULL THEN plan_code_snapshot ELSE $11 END,price_minor_snapshot=CASE WHEN $9::jsonb IS NULL THEN price_minor_snapshot ELSE $12 END,currency_snapshot=CASE WHEN $9::jsonb IS NULL THEN currency_snapshot ELSE $13 END,billing_interval_snapshot=CASE WHEN $9::jsonb IS NULL THEN billing_interval_snapshot ELSE $14 END,duration_days_snapshot=CASE WHEN $9::jsonb IS NULL THEN duration_days_snapshot ELSE $15 END,commercial_snapshot=CASE WHEN $9::jsonb IS NULL THEN commercial_snapshot ELSE $9::jsonb END,updated_at=NOW() WHERE id=$16 RETURNING *`, [customerId, planId, status, startsAt, endsAt, cancelAtPeriodEnd, providerCustomerId, providerPriceId, snapshotJson, planNameSnapshot, planCodeSnapshot, priceMinorSnapshot, currencySnapshot, billingIntervalSnapshot, durationDaysSnapshot, existing.rows[0].id]);
            row = updated.rows[0];
        } else {
            const inserted = await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,cancel_at_period_end,provider_customer_id,provider_subscription_id,provider_price_id_snapshot,plan_name_snapshot,plan_code_snapshot,price_minor_snapshot,currency_snapshot,billing_interval_snapshot,duration_days_snapshot,commercial_snapshot) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,COALESCE($17::jsonb,'{}'::jsonb)) RETURNING *`, [customerId, planId, status, provider, startsAt, endsAt, cancelAtPeriodEnd, providerCustomerId, providerSubscriptionId, providerPriceId, planNameSnapshot, planCodeSnapshot, priceMinorSnapshot, currencySnapshot, billingIntervalSnapshot, durationDaysSnapshot, snapshotJson]);
            row = inserted.rows[0];
        }
        await syncProviderAccessState({ customerId: row.customer_id, provider, providerSubscriptionId, status }, client);
        const effectiveDiscountCodeId = discountCodeId || contract?.discountCodeId || null;
        const appliedMinor = contract ? Math.max(0, Number(contract.priceMinor || 0) - Number(contract.discountedMinor ?? contract.priceMinor ?? 0)) : discountAmountAppliedMinor;
        if (effectiveDiscountCodeId) {
            await client.query('SAVEPOINT discount_redemption');
            try {
                await discounts.redeemForSubscriptionTx(client, { discountCodeId: effectiveDiscountCodeId, customerId, subscriptionId: row.id, amountAppliedMinor: appliedMinor });
                await client.query('RELEASE SAVEPOINT discount_redemption');
            } catch (error) {
                console.error('Discount redemption bookkeeping failed; subscription is still being activated:', error.message);
                await client.query('ROLLBACK TO SAVEPOINT discount_redemption');
            }
        }
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES('payment.subscription.activate','subscription',$1,$2::jsonb)`, [row.id, JSON.stringify({ provider, customerId, planId, providerSubscriptionId, providerPriceId, status, checkoutContract: Boolean(contract) })]);
        return row;
    });
    if (providerCustomerId) await ensurePaymentCustomer({ customerId, provider, providerCustomerId });
    await reconcileCommittedCustomer(customerId, 'Paid subscription');
    try { await referrals.rewardIfQualifying(customerId); }
    catch (error) { console.error('Referral reward check failed:', error.message); }
    return subscription;
}

async function updateProviderSubscription({ provider, providerSubscriptionId, providerStatus, periodEnd = null, cancelAtPeriodEnd = null }) {
    const status = mapProviderStatus(provider, providerStatus);
    if (!status) console.warn(`Ignoring unknown ${provider} subscription status without changing access state:`, String(providerStatus || 'unknown').slice(0, 120));
    const row = await transaction(async client => {
        const result = await client.query(`UPDATE subscriptions SET status=COALESCE($1,status),current_period_end=COALESCE($2,current_period_end),cancel_at_period_end=COALESCE($3,cancel_at_period_end),updated_at=NOW() WHERE source=$4 AND provider_subscription_id=$5 RETURNING *`, [status, periodEnd ? new Date(periodEnd) : null, cancelAtPeriodEnd, provider, providerSubscriptionId]);
        if (!result.rowCount) return null;
        if (status) await syncProviderAccessState({ customerId: result.rows[0].customer_id, provider, providerSubscriptionId, status }, client);
        return result.rows[0];
    });
    if (row) await reconcileCommittedCustomer(row.customer_id, 'Provider subscription');
    return row;
}

module.exports = {
    PAYMENT_EVENT_LEASE_MINUTES,
    PAYMENT_EVENT_RETRY_MINUTES,
    PAYMENT_DELINQUENCY_HOLD_TYPE,
    addPlanDuration,
    mapProviderStatus,
    paymentDelinquencySourceKey,
    syncProviderAccessState,
    reconcileCommittedCustomer,
    ensurePaymentCustomer,
    findPaymentCustomer,
    beginPaymentEvent,
    finishPaymentEvent,
    claimRetryablePaymentEvents,
    purchaseSnapshot,
    activatePurchase,
    updateProviderSubscription
};
