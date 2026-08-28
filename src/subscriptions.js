'use strict';

const { query } = require('./db');
const manualSubscriptions = require('./entitlements/manual-subscriptions');

async function getPlanByCode(code) {
    const result = await query('SELECT * FROM plans WHERE code=$1 AND active=TRUE', [code]);
    return result.rows[0] || null;
}

async function createManualSubscription({ customerId, planId, startsAt, endsAt, actorUserId = null, source = 'manual' }) {
    return manualSubscriptions.createManualSubscription({
        customerId,
        planId,
        startsAt,
        endsAt,
        actorUserId,
        source,
        status: 'active',
        auditAction: 'subscription.create'
    });
}

// Legacy compatibility entry point. Webhook adapters own event verification and
// durable payment-event leasing. This helper only synchronizes an already-known
// recurring provider subscription, so callers cannot accidentally open a second
// payment_events lease for the same provider notification.
async function applyProviderState({ provider, providerSubscriptionId, status, periodEnd = null, cancelAtPeriodEnd = null }) {
    if (!['stripe', 'paypal'].includes(provider)) throw new Error('Provider state sync supports recurring Stripe or PayPal subscriptions only.');
    const lifecycle = require('./payments/lifecycle');
    const subscription = await lifecycle.updateProviderSubscription({
        provider,
        providerSubscriptionId,
        providerStatus: status,
        periodEnd,
        cancelAtPeriodEnd
    });
    return { duplicate: false, subscription };
}

module.exports = { getPlanByCode, createManualSubscription, applyProviderState };
