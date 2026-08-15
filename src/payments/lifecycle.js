'use strict';

const core = require('./lifecycle-core');
const { query } = require('../db');
const state = require('../entitlements/subscription-state');

async function getProviderOptions(planCode, provider) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND p.active=TRUE AND p.visible=TRUE
          AND p.audience IN ('direct','both')
          AND pp.provider=$2 AND pp.active=TRUE
        ORDER BY CASE pp.checkout_mode WHEN 'payment' THEN 0 ELSE 1 END
    `, [planCode, provider]);
    return result.rows;
}

async function getProviderPlan(planCode, provider, checkoutMode = null) {
    const mode = checkoutMode && ['payment','subscription'].includes(checkoutMode) ? checkoutMode : null;
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND p.active=TRUE AND p.visible=TRUE
          AND p.audience IN ('direct','both')
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
          AND p.active=TRUE AND p.audience IN ('direct','both')
        LIMIT 1
    `, [provider, externalId]);
    return result.rows[0] || null;
}

async function assertDirectPlan(planCode, { free = false, trial = false } = {}) {
    const result = await query(`SELECT * FROM plans WHERE code=$1 AND active=TRUE AND visible=TRUE LIMIT 1`, [String(planCode || '').trim()]);
    if (!result.rowCount) throw new Error('Plan is not available.');
    const plan = state.assertAudience(result.rows[0], 'customer');
    if (free && (Number(plan.price_minor) !== 0 || plan.billing_interval === 'trial')) throw new Error('This free plan is not available.');
    if (trial && plan.billing_interval !== 'trial') throw new Error('This trial is not available.');
    return plan;
}

async function trialPolicy() {
    const result = await query(`SELECT setting_value FROM platform_settings WHERE setting_key='trial_free_policy'`);
    const value = result.rows[0]?.setting_value || {};
    return {
        trialMode: ['once_ever','once_per_plan','before_paid'].includes(value.trialMode) ? value.trialMode : 'once_ever',
        freeMode: ['once_per_plan','renewable','permanent'].includes(value.freeMode) ? value.freeMode : 'once_per_plan',
        paidCanClaimFree: value.paidCanClaimFree === true,
        downgradeToFree: value.downgradeToFree === true
    };
}

async function enforceTrialEligibility(customerId, plan) {
    const policy = await trialPolicy();
    if (policy.trialMode === 'once_per_plan') {
        const prior = await query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND status<>'cancelled' LIMIT 1`, [customerId, plan.id]);
        if (prior.rowCount) throw new Error('This trial has already been used.');
    } else {
        const priorTrial = await query(`SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=$1 AND p.billing_interval='trial' LIMIT 1`, [customerId]);
        if (priorTrial.rowCount) throw new Error('A trial has already been used on this account.');
        if (policy.trialMode === 'before_paid') {
            const paid = await query(`SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
                WHERE s.customer_id=$1 AND p.billing_interval<>'trial' AND p.price_minor>0 LIMIT 1`, [customerId]);
            if (paid.rowCount) throw new Error('Trials are only available before the first paid subscription.');
        }
    }
}

async function startFreeTrial(customerId, planCode) {
    const plan = await assertDirectPlan(planCode, { trial: true });
    await enforceTrialEligibility(customerId, plan);
    return core.startFreeTrial(customerId, planCode);
}

async function claimFreePlan(customerId, planCode) {
    const plan = await assertDirectPlan(planCode, { free: true });
    const policy = await trialPolicy();
    if (!policy.paidCanClaimFree) {
        const paid = await query(`SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=$1 AND s.superseded_by IS NULL AND s.status IN ('active','trialing','past_due','paused')
              AND s.current_period_end>NOW() AND p.price_minor>0 LIMIT 1`, [customerId]);
        if (paid.rowCount) throw new Error('Free access cannot be claimed while a paid entitlement is active.');
    }
    if (policy.freeMode !== 'renewable') {
        const prior = await query('SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source=\'free_claim\' LIMIT 1', [customerId, plan.id]);
        if (prior.rowCount) throw new Error('Free access on this plan has already been claimed.');
    }
    return core.claimFreePlan(customerId, planCode);
}

async function activatePurchase(input) {
    const planResult = await query('SELECT * FROM plans WHERE id=$1 AND active=TRUE', [input.planId]);
    if (!planResult.rowCount) throw new Error('Plan not found.');
    state.assertAudience(planResult.rows[0], 'customer');
    if (state.recurringProvider({ source: input.provider, provider_subscription_id: input.providerSubscriptionId })) {
        const same = await query(`SELECT id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 LIMIT 1`, [input.provider, input.providerSubscriptionId]);
        if (!same.rowCount) await state.assertNoOtherLiveRecurring({ query }, input.customerId);
    }
    return core.activatePurchase(input);
}

module.exports = {
    ...core,
    getProviderOptions,
    getProviderPlan,
    getProviderPlanByExternalId,
    startFreeTrial,
    claimFreePlan,
    activatePurchase,
    trialPolicy
};
