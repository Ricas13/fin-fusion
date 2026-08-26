'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const discovery = require('../src/payments/subscription-discovery');

assert(discovery.recurringId('stripe', 'sub_123'));
assert(discovery.recurringId('paypal', 'I-ABC123'));
assert(!discovery.recurringId('stripe', 'pi_123'));
assert(!discovery.recurringId('paypal', 'PAY-123'));

const stripe = discovery.normalizeStripeSubscription({
    id: 'sub_live', customer: 'cus_1', status: 'active', cancel_at_period_end: false,
    items: { data: [{ current_period_end: 1800000000, price: { id: 'price_premium' } }] }
}, { id: 'cus_1', email: 'Premium@Example.com' });
assert.strictEqual(stripe.provider, 'stripe');
assert.strictEqual(stripe.providerCustomerId, 'cus_1');
assert.strictEqual(stripe.email, 'Premium@Example.com');
assert.deepStrictEqual(stripe.externalPlanIds, ['price_premium']);
assert(discovery.currentRemote(stripe));

const paypal = discovery.normalizePayPalSubscription({
    id: 'I-LIVE1', plan_id: 'P-PREMIUM', status: 'ACTIVE',
    subscriber: { payer_id: 'PAYER-1', email_address: 'paypal@example.com' },
    billing_info: { next_billing_time: '2027-01-01T00:00:00Z' }
});
assert.strictEqual(paypal.providerCustomerId, 'PAYER-1');
assert.deepStrictEqual(paypal.externalPlanIds, ['P-PREMIUM']);
assert(discovery.currentRemote(paypal));
assert(!discovery.currentRemote({ ...paypal, status: 'CANCELLED' }), 'cancelled PayPal subscriptions must never be auto-linked');

function baseContext() {
    return {
        providerIdentityToCustomers: new Map([
            ['stripe:cus_1', new Set(['customer-1'])],
            ['paypal:PAYER-1', new Set(['customer-2'])]
        ]),
        emailToCustomers: new Map([
            ['premium@example.com', new Set(['customer-1'])],
            ['paypal@example.com', new Set(['customer-2'])]
        ]),
        externalToPlans: new Map([
            ['stripe:price_premium', new Set(['plan-premium'])],
            ['paypal:P-PREMIUM', new Set(['plan-premium-paypal'])]
        ]),
        providerSubscriptionOwners: new Map()
    };
}

const local = {
    customer_id: 'customer-1', subscription_id: 'local-sub-1', plan_id: 'plan-premium',
    source: 'manual', provider_subscription_id: null, provider_customer_id: null,
    email: 'premium@example.com', plan_name: 'Premium Monthly', plan_code: 'premium-monthly'
};
let matches = discovery.matchPremiumRows([local], [stripe], baseContext());
assert.strictEqual(matches.length, 1);
assert.strictEqual(matches[0].state, 'safe');
assert.strictEqual(matches[0].match.id, 'sub_live');
assert(/Exact plan/.test(matches[0].reason));

const duplicate = { ...stripe, id: 'sub_live_2' };
matches = discovery.matchPremiumRows([local], [stripe, duplicate], baseContext());
assert.strictEqual(matches[0].state, 'ambiguous', 'two live exact matches must never be guessed');
assert.strictEqual(matches[0].match, null);

const conflictContext = baseContext();
conflictContext.providerSubscriptionOwners.set('stripe:sub_live', { subscriptionId: 'some-other-local-sub', customerId: 'someone-else' });
matches = discovery.matchPremiumRows([local], [stripe], conflictContext);
assert.strictEqual(matches[0].state, 'conflict', 'a remote subscription already owned locally must never be stolen');

const identityMismatch = baseContext();
identityMismatch.providerIdentityToCustomers.set('stripe:cus_1', new Set(['different-customer']));
matches = discovery.matchPremiumRows([local], [stripe], identityMismatch);
assert.strictEqual(matches[0].state, 'unresolved', 'a known provider-customer-ID mismatch must never be overridden by matching email');

matches = discovery.matchPremiumRows([{ ...local, source: 'stripe', provider_subscription_id: 'sub_existing' }], [stripe], baseContext());
assert.strictEqual(matches[0].state, 'linked', 'already-linked premium users must not be rewritten');

matches = discovery.matchPremiumRows([local], [{ ...stripe, status: 'canceled' }], baseContext());
assert.strictEqual(matches[0].state, 'unresolved', 'cancelled Stripe subscriptions must not be used to justify premium access');

const discoverySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'subscription-discovery.js'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'lifecycle.js'), 'utf8');
assert.ok(discoverySource.includes("e.server_class='premium'"), 'discovery must be scoped to active Premium Server entitlements');
assert.ok(discoverySource.includes("IN ('jellyfin','bundle')"), 'discovery must only cover Jellyfin-capable premium entitlements');
assert.ok(discoverySource.includes("status: 'all'"), 'Stripe discovery must inspect all subscriptions before selecting current states');
assert.ok(discoverySource.includes("PAYPAL_TRANSACTION_TYPES = Object.freeze(['T0002', 'T0003'])"), 'PayPal discovery must cover subscription and preapproved recurring payments');
assert.ok(discoverySource.includes("paypal_reference_id_type || '').toUpperCase() === 'SUB'"), 'PayPal discovery must only treat SUB references as subscription IDs');
assert.ok(!/activatePurchase\s*\(/.test(discoverySource), 'subscription discovery must attach provider billing to existing premium entitlements, never create a new entitlement');
assert.ok(!/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+subscriptions\b/i.test(discoverySource), 'discovery must not mutate provider-backed subscriptions outside the lifecycle owner');
assert.ok(discoverySource.includes("require('./lifecycle')"), 'discovery must delegate provider-backed linking to the canonical lifecycle owner');
assert.ok(lifecycleSource.includes('attachDiscoveredProviderSubscription'), 'lifecycle must own discovered provider-subscription attachment');
assert.ok(lifecycleSource.includes('assertNoOtherLiveRecurring'), 'lifecycle attachment must preserve the one-live-recurring-primary invariant');
assert.ok(/plan_id=\$2[\s\S]*external_id=ANY\(\$3::text\[\]\)/.test(lifecycleSource), 'lifecycle must snapshot the exact remote price/plan that maps to the existing premium plan');

const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-billing.js'), 'utf8');
assert.ok(adminSource.includes('/admin/billing/discover/preview'), 'Billing must expose preview-first subscription discovery');
assert.ok(adminSource.includes('/admin/billing/discover/apply'), 'Billing must expose an explicit safe-link action');
assert.ok(adminSource.includes("req.body?.confirm !== '1'"), 'bulk provider linking must require explicit confirmation');
assert.ok(adminSource.includes('Premium subscription integrity'), 'Billing must permanently surface premium users missing provider links');
assert.ok(adminSource.includes('csrf.verify(req)'), 'discovery mutations must be CSRF protected');

console.log('Subscription discovery smoke passed.');
