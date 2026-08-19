const { query } = require('./db');
const manualSubscriptions = require('./entitlements/manual-subscriptions');

async function getPlanByCode(code) {
    const result = await query('SELECT * FROM plans WHERE code=$1 AND active=TRUE', [code]);
    return result.rows[0] || null;
}

// Compatibility API retained for existing callers. Manual subscription writes
// now have one entitlement-domain owner rather than being implemented here.
async function createManualSubscription(options) {
    return manualSubscriptions.createManualSubscription(options);
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
