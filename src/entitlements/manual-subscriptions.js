'use strict';

const { transaction } = require('../db');

function validDate(value, name) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new Error(`${name} must be a valid date.`);
    return date;
}

function cleanSource(value) {
    const source = String(value || 'manual').trim();
    if (!/^[a-z0-9_-]{1,40}$/i.test(source)) throw new Error('Subscription source is invalid.');
    return source;
}

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
    if (!customerId) throw new Error('Customer id is required.');
    if (!planId) throw new Error('Plan id is required.');

    const start = validDate(startsAt, 'Subscription start');
    const end = validDate(endsAt, 'Subscription end');
    if (end <= start) throw new Error('Subscription end must be after its start.');

    const normalizedStatus = String(status || 'active').trim();
    if (!['active', 'trialing'].includes(normalizedStatus)) throw new Error('Manual subscription status is invalid.');
    const normalizedSource = cleanSource(source);

    const result = await client.query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,$3,$4,$5,$6)
        RETURNING *
    `, [customerId, planId, normalizedStatus, normalizedSource, start, end]);

    await client.query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'subscription',$3,$4::jsonb)
    `, [actorUserId, auditAction, result.rows[0].id, JSON.stringify({
        source: normalizedSource,
        customerId,
        planId,
        startsAt: start,
        endsAt: end,
        ...auditMetadata
    })]);

    return result.rows[0];
}

async function createManualSubscription(options) {
    return transaction(client => createManualSubscriptionTx(client, options));
}

module.exports = { createManualSubscriptionTx, createManualSubscription, cleanSource, validDate };
