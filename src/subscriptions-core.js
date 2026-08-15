const { transaction, query } = require('./db');
const { reconcileCustomer } = require('./jellyfin/resilient-provisioning');

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

async function applyResellerCredit(client, { resellerId, customerId, planCode, units, wallet, actorUserId }) {
    const reseller = await client.query('SELECT * FROM resellers WHERE id=$1 FOR UPDATE', [resellerId]);
    if (!reseller.rowCount) throw new Error('Reseller not found');

    const plan = await client.query(`
        SELECT * FROM plans
        WHERE code=$1 AND active=TRUE AND audience IN ('reseller','both')
        FOR SHARE
    `, [planCode]);
    if (!plan.rowCount) throw new Error('Reseller plan not found');
    const p = plan.rows[0];

    const unitCost = wallet === 'trial' ? p.reseller_trial_credit_cost : p.reseller_credit_cost;
    if (unitCost === null || unitCost === undefined) throw new Error(`Plan is not available for ${wallet} credits`);
    const totalCost = Number(unitCost) * units;
    const balanceField = wallet === 'trial' ? 'trial_credits' : 'credits';
    if (Number(reseller.rows[0][balanceField] || 0) < totalCost) throw new Error('Insufficient reseller credits');

    const existing = await client.query(`
        SELECT * FROM subscriptions
        WHERE customer_id=$1 AND status IN ('active','trialing','past_due')
        ORDER BY current_period_end DESC LIMIT 1 FOR UPDATE
    `, [customerId]);

    const now = new Date();
    const base = existing.rowCount && new Date(existing.rows[0].current_period_end) > now
        ? new Date(existing.rows[0].current_period_end)
        : now;
    const durationDays = p.duration_days || 30;
    const newEnd = new Date(base.getTime() + durationDays * units * 86400000);

    let subscription;
    if (existing.rowCount) {
        const updated = await client.query(`
            UPDATE subscriptions
            SET plan_id=$1,status='active',source='reseller_credit',current_period_end=$2,updated_at=NOW()
            WHERE id=$3 RETURNING *
        `, [p.id, newEnd, existing.rows[0].id]);
        subscription = updated.rows[0];
    } else {
        const created = await client.query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active','reseller_credit',$3,$4) RETURNING *
        `, [customerId, p.id, now, newEnd]);
        subscription = created.rows[0];
    }

    if (wallet === 'trial') {
        await client.query('UPDATE resellers SET trial_credits=trial_credits-$1 WHERE id=$2', [totalCost, resellerId]);
    } else {
        await client.query('UPDATE resellers SET credits=credits-$1 WHERE id=$2', [totalCost, resellerId]);
    }
    await client.query(`
        INSERT INTO credit_transactions(reseller_id,amount,transaction_type,note,created_by)
        VALUES($1,$2,'deduct',$3,$4)
    `, [resellerId, -totalCost, `Subscription extension: ${planCode} x${units} (${wallet})`, actorUserId]);
    await client.query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'subscription.extend.reseller_credit','subscription',$2,$3::jsonb)
    `, [actorUserId, subscription.id, JSON.stringify({ resellerId, customerId, planCode, units, wallet, unitCost, totalCost, newEnd })]);

    return subscription;
}

async function safeReconcile(customerId) {
    try {
        return { reconcile: await reconcileCustomer(customerId), reconcileError: null };
    } catch (error) {
        console.error(`Reseller credit reconcile failed for customer ${customerId} (credits already committed):`, error.message);
        return { reconcile: null, reconcileError: error.message };
    }
}

async function extendWithResellerCredits({ resellerId, customerId, planCode = 'monthly', units = 1, wallet = 'regular', actorUserId }) {
    if (!Number.isInteger(units) || units < 1 || units > 24) throw new Error('units must be an integer from 1 to 24');
    if (!['regular','trial'].includes(wallet)) throw new Error('Unsupported reseller credit wallet');

    const subscription = await transaction(client => applyResellerCredit(client, { resellerId, customerId, planCode, units, wallet, actorUserId }));
    const { reconcile, reconcileError } = await safeReconcile(customerId);
    return { subscription, reconcile, reconcileError };
}

async function createResellerClient({ resellerId, username, planCode, actorUserId }) {
    if (!/^[A-Za-z0-9._-]{3,40}$/.test(String(username || ''))) throw new Error('Enter a valid username.');

    const subscription = await transaction(async client => {
        const customer = await client.query(
            'INSERT INTO customers(reseller_id,display_name) VALUES($1,$2) RETURNING id',
            [resellerId, username]
        );
        return applyResellerCredit(client, {
            resellerId, customerId: customer.rows[0].id, planCode, units: 1, wallet: 'trial', actorUserId
        });
    });
    const { reconcile, reconcileError } = await safeReconcile(subscription.customer_id);
    return { subscription, reconcile, reconcileError };
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

module.exports = { getPlanByCode, createManualSubscription, extendWithResellerCredits, createResellerClient, applyProviderState };
