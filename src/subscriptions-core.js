const { transaction, query } = require('./db');

async function getPlanByCode(code) {
    const result = await query('SELECT * FROM plans WHERE code=$1 AND active=TRUE', [code]);
    return result.rows[0] || null;
}

async function createManualSubscription({ customerId, planId, startsAt, endsAt, actorUserId = null, source = 'manual' }) {
    return transaction(async client => {
        const result = await client.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active',$3,$4,$5)
            RETURNING *
        `, [customerId, planId, source, startsAt, endsAt]);

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'subscription.create','subscription',$2,$3::jsonb)
        `, [actorUserId, result.rows[0].id, JSON.stringify({ source, customerId, planId })]);

        return result.rows[0];
    });
}

// Legacy compatibility entry point. Provider-backed subscription state is no
// longer mutated here; it delegates to the canonical payment lifecycle owner so
// duplicate event leasing, reconciliation and provider-state mapping stay in
// one place.
async function applyProviderState({ provider, providerEventId, eventType, payload, providerSubscriptionId, status, periodEnd }) {
    if (!['stripe', 'paypal'].includes(provider)) throw new Error('Unsupported provider');
    const lifecycle = require('./payments/lifecycle');
    const event = await lifecycle.beginPaymentEvent({ provider, eventId: providerEventId, eventType, payload });
    if (!event) return { duplicate: true };
    try {
        const subscription = await lifecycle.updateProviderSubscription({
            provider,
            providerSubscriptionId,
            providerStatus: status,
            periodEnd: periodEnd || null
        });
        await lifecycle.finishPaymentEvent(event);
        return { duplicate: false, subscription };
    } catch (error) {
        await lifecycle.finishPaymentEvent(event, error);
        throw error;
    }
}

module.exports = { getPlanByCode, createManualSubscription, applyProviderState };
