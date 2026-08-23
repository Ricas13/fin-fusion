'use strict';

const { transaction } = require('../db');
const planExpiry = require('./plan-expiry');

async function createManualSubscriptionTx(client, {
    customerId,
    planId,
    startsAt,
    endsAt,
    actorUserId = null,
    source = 'manual',
    status = 'active',
    auditAction = 'subscription.create',
    auditMetadata = {}
}) {
    if (!client?.query) throw new Error('A database transaction client is required.');

    const planResult = await client.query('SELECT id,is_free_tier,duration_days,billing_interval FROM plans WHERE id=$1', [planId]);
    if (!planResult.rowCount) throw new Error('Plan not found.');
    const plan = planResult.rows[0];
    const periodEnd = planExpiry.isFreeTier(plan)
        ? planExpiry.freeTierEnd()
        : endsAt || planExpiry.endForPlan(plan, { now: startsAt ? new Date(startsAt) : new Date() });

    const result = await client.query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING *
    `, [customerId, planId, status, source, startsAt, periodEnd]);

    await client.query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'subscription',$3,$4::jsonb)
    `, [actorUserId, auditAction, result.rows[0].id, JSON.stringify({
        source,
        customerId,
        planId,
        freeTier: planExpiry.isFreeTier(plan),
        ...auditMetadata
    })]);

    return result.rows[0];
}

async function createManualSubscription(options) {
    return transaction(client => createManualSubscriptionTx(client, options));
}

module.exports = { createManualSubscriptionTx, createManualSubscription };
