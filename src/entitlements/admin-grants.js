'use strict';

const manualSubscriptions = require('./manual-subscriptions');

function addPlanDuration(plan, from = new Date()) {
    const days = Number(plan?.duration_days || 30);
    return new Date(from.getTime() + days * 86400000);
}

function statusForPlan(plan) {
    return plan?.billing_interval === 'trial' ? 'trialing' : 'active';
}

async function eligiblePlanTx(client, planCode) {
    if (!client?.query) throw new Error('A database transaction client is required.');
    const code = String(planCode || '').trim();
    const result = await client.query(`
        SELECT * FROM plans
        WHERE code=$1
          AND active=TRUE
          AND archived_at IS NULL
          AND (effective_from IS NULL OR effective_from<=NOW())
          AND (effective_until IS NULL OR effective_until>NOW())
          AND audience IN('direct','both')
        LIMIT 1
    `, [code]);
    if (!result.rowCount) throw new Error('Choose an active direct-customer plan.');
    return result.rows[0];
}

async function createAdminGrantTx(client, { customerId, plan, actorUserId = null }) {
    if (!plan?.id) throw new Error('Plan is required.');
    const startsAt = new Date();
    const endsAt = addPlanDuration(plan, startsAt);
    return manualSubscriptions.createManualSubscriptionTx(client, {
        customerId,
        planId: plan.id,
        startsAt,
        endsAt,
        actorUserId,
        source: 'admin_grant',
        status: statusForPlan(plan),
        auditAction: 'subscription.admin_grant',
        auditMetadata: { planCode: plan.code || null, startsAt, endsAt }
    });
}

async function createAdminGrantByPlanCodeTx(client, { customerId, planCode, actorUserId = null }) {
    const plan = await eligiblePlanTx(client, planCode);
    const subscription = await createAdminGrantTx(client, { customerId, plan, actorUserId });
    return { plan, subscription };
}

module.exports = {
    createAdminGrantTx,
    createAdminGrantByPlanCodeTx,
    eligiblePlanTx,
    addPlanDuration,
    statusForPlan
};
