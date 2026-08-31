'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const discovery = require('../src/payments/subscription-discovery');
const manualLink = require('../src/payments/manual-subscription-link');
const adminBilling = require('../src/platform/admin-billing');

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

const legacyPaypal = manualLink.normalizeLegacyPayPalAgreement({
    id: 'I-LEGACY1', state: 'Active',
    payer: { payer_info: { payer_id: 'PAYER-LEGACY', email: 'legacy@example.com' } },
    agreement_details: { next_billing_date: '2027-02-01T00:00:00Z' },
    plan: { id: 'P-LEGACY' }
});
assert.strictEqual(legacyPaypal.provider, 'paypal');
assert.strictEqual(legacyPaypal.id, 'I-LEGACY1');
assert.strictEqual(legacyPaypal.providerCustomerId, 'PAYER-LEGACY');
assert.strictEqual(legacyPaypal.email, 'legacy@example.com');
assert.strictEqual(legacyPaypal.status, 'ACTIVE');
assert.deepStrictEqual(legacyPaypal.externalPlanIds, ['P-LEGACY']);
assert.strictEqual(legacyPaypal.apiFamily, 'billing-agreements-v1');
assert(discovery.currentRemote(legacyPaypal), 'active legacy PayPal billing agreements must be eligible for verified manual recovery');

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

assert.strictEqual(adminBilling.recurringProblems({ subscriptions: [{ recurring:true,status:'past_due',cancel_at_period_end:true,last_error:null }] }).length, 0, 'past-due subscriptions intentionally ending after the current period must not stay in the operator problem queue');
assert.strictEqual(adminBilling.recurringProblems({ subscriptions: [{ recurring:true,status:'past_due',cancel_at_period_end:false,last_error:null }] }).length, 1, 'past-due subscriptions still expected to renew must remain operator work');
assert.strictEqual(adminBilling.recurringProblems({ subscriptions: [{ recurring:true,status:'past_due',cancel_at_period_end:true,last_error:'provider sync failed' }] }).length, 1, 'provider sync failures must remain operator work even when renewal is stopped');

const discoverySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'subscription-discovery.js'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'lifecycle.js'), 'utf8');
const manualSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'manual-subscription-link.js'), 'utf8');
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

assert.ok(manualSource.includes("require('./subscription-discovery')"), 'manual recovery must reuse canonical premium/discovery normalization');
assert.ok(manualSource.includes("require('./lifecycle')"), 'manual recovery must delegate the write to lifecycle');
assert.ok(manualSource.includes('attachDiscoveredProviderSubscription'), 'manual recovery must use the same canonical attachment owner as automatic discovery');
assert.ok(manualSource.includes("checkout_mode='subscription' AND plan_id=$2"), 'manual recovery must verify exact local plan mapping');
assert.ok(manualSource.includes('provider_subscription_id=$2'), 'manual recovery must reject already-owned provider subscriptions');
assert.ok(manualSource.includes('operatorConfirmed'), 'manual recovery must require explicit operator ownership confirmation');
assert.ok(manualSource.includes("discovery.currentRemote(remote)"), 'manual recovery must refuse non-current provider subscriptions');
assert.ok(manualSource.includes('/v1/billing/subscriptions/'), 'manual PayPal recovery must try the current Subscriptions API first');
assert.ok(manualSource.includes('/v1/payments/billing-agreements/'), 'manual PayPal recovery must fall back to legacy Billing Agreements v1 for migrated I- profiles');
assert.ok(manualSource.includes("apiFamily: 'billing-agreements-v1'"), 'legacy PayPal normalization must remain distinguishable for operator diagnostics');
assert.ok(manualSource.includes("expand: ['items.data.price']"), 'manual Stripe recovery must retrieve subscription truth without requiring Customer expansion permission');
assert.ok(!manualSource.includes("expand: ['customer', 'items.data.price']"), 'manual Stripe recovery must not require restricted-key Customer expansion permission');
assert.ok(manualSource.includes('stripe.customers.retrieve(customerId)'), 'manual Stripe recovery may enrich customer identity separately when permission allows');
assert.ok(manualSource.includes('Stripe subscription lookup failed'), 'manual Stripe lookup failures must retain provider detail instead of collapsing to a generic 400');
assert.ok(!/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+subscriptions\b/i.test(manualSource), 'manual recovery must not mutate subscriptions outside lifecycle');

const adminSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-billing.js'), 'utf8');
assert.ok(adminSource.includes('/admin/billing/discover/preview'), 'Billing must expose preview-first subscription discovery');
assert.ok(adminSource.includes('/admin/billing/discover/apply'), 'Billing must expose an explicit safe-link action');
assert.ok(adminSource.includes("req.body?.confirm !== '1'"), 'provider linking must require explicit confirmation');
assert.ok(adminSource.includes('Missing provider links'), 'Billing must permanently name the missing-provider operator queue');
assert.ok(adminSource.includes("premiumRows.filter(row=>!discovery.recurringId(row.source,row.provider_subscription_id))"), 'Billing must list unlinked premium customers instead of hiding them from the recurring table');
assert.ok(adminSource.includes('/admin/billing/:id/manual-preview'), 'each missing link must support read-only provider verification');
assert.ok(adminSource.includes('/admin/billing/:id/manual-link'), 'each missing link must support explicit verified attachment');
assert.ok(adminSource.includes('Verify provider subscription'), 'manual resolution must show provider truth before attachment');
assert.ok(adminSource.includes('/manual-preview#manual-provider-preview'), 'manual verification submissions must target the rendered verification feedback instead of returning the operator to the page top');
assert.ok(adminSource.includes('data-native-submit="true"'), 'manual provider verification must use native navigation so server-rendered 400 details are not swallowed by generic AJAX form feedback');
assert.ok(adminSource.includes('Subscription verification failed'), 'manual verification failures must be visibly rendered in the same operator workflow');
assert.ok(adminSource.includes('Provider verification succeeded.'), 'successful provider verification must have explicit visible feedback before linking');
assert.ok(adminSource.includes('manualAttempt'), 'manual verification errors must preserve enough attempted-provider context to explain what failed');
assert.ok(adminSource.includes('${verification}${table}'), 'manual verification feedback must render before the missing-subscription table, not after the full page');
assert.ok(adminSource.includes("row.status==='past_due'&&!row.cancel_at_period_end"), 'intentional end-of-period cancellations must not remain in the urgent past-due queue');
assert.ok(adminSource.includes("filter(item=>item.state!=='linked')"), 'automatic discovery results must focus on unresolved work instead of healthy rows');
assert.ok(adminSource.includes('Linked recurring subscriptions'), 'linked recurring subscriptions must remain available as secondary/reference information');
assert.ok(adminSource.includes('csrf.verify(req)'), 'discovery and manual recovery mutations must be CSRF protected');

console.log('Subscription discovery smoke passed.');
