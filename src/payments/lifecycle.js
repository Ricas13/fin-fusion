'use strict';

const core = require('./lifecycle-core');
const { query, transaction } = require('../db');
const state = require('../entitlements/subscription-state');
const capacity = require('../entitlements/plan-capacity');
const commerce = require('./commerce-control');
const stremio = require('../stremio/foundation');

function addPlanDuration(plan, from = new Date()) {
    return new Date(from.getTime() + Number(plan.duration_days || 30) * 86400000);
}
function permanentEnd() { return new Date('9999-12-31T23:59:59.000Z'); }
function availableWindowSql(alias='p'){return `${alias}.active=TRUE AND ${alias}.visible=TRUE AND ${alias}.archived_at IS NULL AND (${alias}.effective_from IS NULL OR ${alias}.effective_from<=NOW()) AND (${alias}.effective_until IS NULL OR ${alias}.effective_until>NOW())`;}

async function getProviderOptions(planCode, provider) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
        FROM plans p JOIN plan_provider_prices pp ON pp.plan_id=p.id
        WHERE p.code=$1 AND ${availableWindowSql('p')}
          AND ${capacity.acquisitionSql('p')}
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
        WHERE p.code=$1 AND ${availableWindowSql('p')}
          AND ${capacity.acquisitionSql('p')}
          AND p.audience IN ('direct','both')
          AND pp.provider=$2 AND pp.active=TRUE
          AND ($3::text IS NULL OR pp.checkout_mode=$3)
        ORDER BY CASE pp.checkout_mode WHEN 'payment' THEN 0 ELSE 1 END
        LIMIT 1
    `, [planCode, provider, mode]);
    const plan=result.rows[0]||null;
    if(plan)stremio.assertAcquirable(plan,{context:`new ${provider} checkout`});
    return plan;
}

// This resolver is used for signed provider events after money may already have
// moved. Catalogue/mapping retirement or a slot becoming full blocks NEW
// checkout, not fulfilment of an already-authorised provider object.
async function getProviderPlanByExternalId(provider, externalId) {
    const result = await query(`
        SELECT p.*,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata,pp.active AS mapping_active
        FROM plan_provider_prices pp JOIN plans p ON p.id=pp.plan_id
        WHERE pp.provider=$1 AND pp.external_id=$2
          AND p.audience IN ('direct','both')
        ORDER BY pp.updated_at DESC
        LIMIT 1
    `, [provider, externalId]);
    return result.rows[0] || null;
}

async function assertDirectPlan(planCode, { free = false, trial = false } = {}) {
    const result = await query(`SELECT * FROM plans p WHERE p.code=$1 AND ${availableWindowSql('p')} AND ${capacity.acquisitionSql('p')} LIMIT 1`, [String(planCode || '').trim()]);
    if (!result.rowCount) throw new Error('Plan is not available or is currently sold out.');
    const plan = state.assertAudience(result.rows[0], 'customer');
    stremio.assertAcquirable(plan,{context:trial?'new trial':free?'new free claim':'new customer acquisition'});
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
        downgradeToFree: value.downgradeToFree === true,
        downgradeFreePlanCode: String(value.downgradeFreePlanCode || '').trim()
    };
}

async function saveTrialPolicy(input, actorUserId = null) {
    const value = {
        trialMode: ['once_ever','once_per_plan','before_paid'].includes(input.trialMode) ? input.trialMode : 'once_ever',
        freeMode: ['once_per_plan','renewable','permanent'].includes(input.freeMode) ? input.freeMode : 'once_per_plan',
        paidCanClaimFree: input.paidCanClaimFree === true,
        downgradeToFree: input.downgradeToFree === true,
        downgradeFreePlanCode: String(input.downgradeFreePlanCode || '').trim()
    };
    if (value.downgradeToFree) {
        const target = await query(`SELECT code FROM plans p WHERE code=$1 AND ${availableWindowSql('p')} AND price_minor=0 AND billing_interval<>'trial' AND audience IN ('direct','both')`, [value.downgradeFreePlanCode]);
        if (!target.rowCount) throw new Error('Choose an active direct free plan for automatic downgrade.');
        stremio.assertAcquirable((await query('SELECT service_type FROM plans WHERE code=$1',[value.downgradeFreePlanCode])).rows[0],{context:'automatic free downgrade'});
    } else value.downgradeFreePlanCode = '';
    await transaction(async client => {
        await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('trial_free_policy',$1::jsonb)
            ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [JSON.stringify(value)]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.commerce.trial_free_policy','platform_setting','trial_free_policy',$2::jsonb)`, [actorUserId, JSON.stringify(value)]);
    });
    return value;
}

async function enforceTrialEligibility(customerId, plan) {
    const policy = await trialPolicy();
    if (policy.trialMode === 'once_per_plan') {
        const prior = await query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 LIMIT 1`, [customerId, plan.id]);
        if (prior.rowCount) throw new Error('This trial has already been used.');
        return policy;
    }
    const priorTrial = await query(`SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        WHERE s.customer_id=$1 AND COALESCE(s.billing_interval_snapshot,p.billing_interval)='trial' LIMIT 1`, [customerId]);
    if (priorTrial.rowCount) throw new Error('A trial has already been used on this account.');
    if (policy.trialMode === 'before_paid') {
        const paid = await query(`SELECT 1 FROM subscriptions s JOIN plans p ON p.id=s.plan_id
            WHERE s.customer_id=$1 AND COALESCE(s.billing_interval_snapshot,p.billing_interval)<>'trial' AND COALESCE(s.price_minor_snapshot,p.price_minor)>0 LIMIT 1`, [customerId]);
        if (paid.rowCount) throw new Error('Trials are only available before the first paid subscription.');
    }
    return policy;
}

async function startFreeTrial(customerId, planCode) {
    await commerce.assertOpen();
    const plan = await assertDirectPlan(planCode, { trial: true });
    await enforceTrialEligibility(customerId, plan);
    const created = await transaction(async client => {
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
        await capacity.lockAndAssert(client,plan.id,plan.name||'This trial');
        const live = await client.query(`SELECT * FROM effective_customer_entitlements WHERE customer_id=$1 LIMIT 1`, [customerId]);
        if (live.rowCount) throw new Error('An active entitlement already exists. Change or cancel it before starting a trial.');
        const startsAt = new Date(), endsAt = addPlanDuration(plan, startsAt);
        const row = await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'trialing','manual',$3,$4) RETURNING *`, [customerId, plan.id, startsAt, endsAt]);
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('subscription.trial.start','subscription',$1,$2::jsonb)`, [row.rows[0].id, JSON.stringify({ customerId, planCode: plan.code })]);
        return row.rows[0];
    });
    await core.reconcileCommittedCustomer(customerId, 'Trial');
    return created;
}

async function claimFreePlan(customerId, planCode, { automatic = false } = {}) {
    if(!automatic)await commerce.assertOpen();
    const plan = await assertDirectPlan(planCode, { free: true });
    const policy = await trialPolicy();
    const created = await transaction(async client => {
        await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE',[customerId]);
        await capacity.lockAndAssert(client,plan.id,plan.name||'This free plan');
        const prior = await client.query(`SELECT 1 FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 AND source='free_claim' LIMIT 1`, [customerId, plan.id]);
        if (policy.freeMode !== 'renewable' && prior.rowCount) throw new Error('Free access on this plan has already been claimed.');
        const liveResult=await client.query(`SELECT * FROM effective_customer_entitlements WHERE customer_id=$1 LIMIT 1`,[customerId]);
        const live=liveResult.rows[0]||null;
        const livePrice=Number(live?.price_minor_snapshot??live?.price_minor??0);
        if(live&&livePrice>0&&!policy.paidCanClaimFree&&!automatic)throw new Error('Free access cannot be claimed while a paid entitlement is active.');
        if(live&&livePrice===0&&String(live.plan_id)===String(plan.id))throw new Error('You already have free access on this plan.');
        const now=new Date(),startsAt=live&&livePrice>0?new Date(live.access_expires_at):now;
        const endsAt=policy.freeMode==='permanent'?permanentEnd():addPlanDuration(plan,startsAt);
        const row=await client.query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',$3,$4) RETURNING *`,[customerId,plan.id,startsAt,endsAt]);
        if(live&&livePrice===0)await state.markSuperseded(client,{subscriptionId:live.subscription_id,replacementId:row.rows[0].id,reason:automatic?'automatic_free_downgrade':'free_plan_change'});
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata) VALUES($1,'subscription',$2,$3::jsonb)`,[automatic?'subscription.free.auto_downgrade':'subscription.free.claim',row.rows[0].id,JSON.stringify({customerId,planCode:plan.code,startsAt,endsAt,freeMode:policy.freeMode})]);
        return row.rows[0];
    });
    await core.reconcileCommittedCustomer(customerId, automatic ? 'Automatic free plan' : 'Free plan');
    return created;
}

async function autoDowngradeEligibleCustomer(customerId) {
    const policy = await trialPolicy();
    if (!policy.downgradeToFree || !policy.downgradeFreePlanCode) return null;
    const live = await query(`SELECT 1 FROM effective_customer_entitlements WHERE customer_id=$1 LIMIT 1`, [customerId]);
    if (live.rowCount) return null;
    try { return await claimFreePlan(customerId, policy.downgradeFreePlanCode, { automatic: true }); }
    catch (error) {
        if (/already been claimed|sold out|not available/i.test(error.message)) return null;
        throw error;
    }
}

async function activatePurchase(input) {
    // Provider callbacks run only after provider authentication/signature checks.
    // At this point catalogue retirement/capacity changes must not strand a paid
    // customer. Capacity is therefore enforced before checkout starts, while an
    // already-authorised provider object is always fulfilled idempotently.
    const planResult = await query('SELECT * FROM plans WHERE id=$1', [input.planId]);
    if (!planResult.rowCount) throw new Error('Plan not found.');
    const plan=state.assertAudience(planResult.rows[0], 'customer');
    const same = input.providerSubscriptionId ? await query(`SELECT id FROM subscriptions WHERE source=$1 AND provider_subscription_id=$2 LIMIT 1`, [input.provider,input.providerSubscriptionId]) : {rowCount:0};
    if(!same.rowCount)stremio.assertAcquirable(plan,{context:'paid subscription activation'});
    if (state.recurringProvider({ source: input.provider, provider_subscription_id: input.providerSubscriptionId })) {
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
    trialPolicy,
    saveTrialPolicy,
    autoDowngradeEligibleCustomer,
    availableWindowSql
};
