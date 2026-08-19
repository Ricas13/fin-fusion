'use strict';

function addPlanDuration(plan, from = new Date()) {
    const days = Number(plan?.duration_days || 30);
    return new Date(from.getTime() + days * 86400000);
}

function statusForPlan(plan) {
    return plan?.billing_interval === 'trial' ? 'trialing' : 'active';
}

async function createAdminGrantTx(client, { customerId, plan, actorUserId = null }) {
    if (!client?.query) throw new Error('A database transaction client is required.');
    if (!customerId) throw new Error('Customer id is required.');
    if (!plan?.id) throw new Error('Plan is required.');

    const startsAt = new Date();
    const endsAt = addPlanDuration(plan, startsAt);
    const created = await client.query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,$3,'admin_grant',$4,$5)
        RETURNING *
    `, [customerId, plan.id, statusForPlan(plan), startsAt, endsAt]);

    await client.query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'subscription.admin_grant','subscription',$2,$3::jsonb)
    `, [actorUserId, created.rows[0].id, JSON.stringify({
        customerId,
        planId: plan.id,
        planCode: plan.code || null,
        startsAt,
        endsAt
    })]);

    return created.rows[0];
}

module.exports = { createAdminGrantTx, addPlanDuration, statusForPlan };
