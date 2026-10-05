'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const discovery = require('../src/payments/subscription-discovery');
const unlinkedPaidTerm = require('../src/payments/unlinked-paid-term');
const manualLink = require('../src/payments/manual-subscription-link');
const adminBilling = require('../src/platform/admin-billing');

assert(discovery.recurringId('stripe', 'sub_123'));
assert(discovery.recurringId('paypal', 'I-ABC123'));
assert(!discovery.recurringId('stripe', 'pi_123'));
assert(!discovery.recurringId('paypal', 'PAY-123'));
assert(!discovery.recurringId('stripe', ' sub_123 '), 'padded local Stripe IDs must remain visible to provider-link repair');
assert(!discovery.recurringId('paypal', ' I-ABC123 '), 'padded local PayPal IDs must remain visible to provider-link repair');
assert(discovery.localRecurring({ source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'sub_123' }), 'a real Stripe subscription ID must remain linked');
assert(!discovery.localRecurring({ source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'pi_123' }), 'a PaymentIntent must never count as a linked recurring Stripe subscription');
const legacyEnding = { source: 'migration', billing_mode: 'manual', provider_subscription_id: null, cancel_at_period_end: true, commercial_snapshot: { kind:'legacy_import', migrated:true, providerLinkDisposition:'ending' } };
const legacyUnmarked = { source: 'migration', billing_mode: 'manual', provider_subscription_id: null, cancel_at_period_end: true, commercial_snapshot: { kind:'legacy_import', migrated:true } };
assert(discovery.endingWithoutRenewal(legacyEnding), 'an explicitly marked legacy paid term intentionally ending after the current period must be reference-only');
assert(!discovery.needsProviderLink(legacyEnding), 'an explicitly ending legacy paid term must not be queued for provider repair');
assert(discovery.needsProviderLink(legacyUnmarked), 'legacy imports must not be hidden merely because their fixed local term has cancel_at_period_end=true');
assert(discovery.endingWithoutRenewal({ source:'stripe', billing_mode:'payment', provider_subscription_id:null, commercial_snapshot:{ checkoutMode:'payment' } }), 'a genuine one-time provider payment never needs a recurring provider link');
assert(unlinkedPaidTerm.fixedTermWithoutProvider({ source:'admin_grant', billing_mode:null, provider_subscription_id:null, commercial_snapshot:{}, cancel_at_period_end:false }), 'historical admin grants without billing_mode must remain fixed-term without a provider instead of entering provider-link repair');

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

const sharedPayPalOwnership = manualLink.ownershipDecision(
    { customer_id:'customer-paypal-b', email:'second@example.com' },
    { provider:'paypal', providerCustomerId:'PAYER-SHARED', email:'different@example.com' },
    ['customer-paypal-a']
);
assert.strictEqual(sharedPayPalOwnership.verified,false,
    'a PayPal payer ID already used by another local customer must remain recoverable with exact subscription identity and operator confirmation');
assert.match(sharedPayPalOwnership.reason,/shared with another local customer/,
    'shared PayPal payer identity must be explained instead of treated as a Stripe-style ownership conflict');
assert.throws(
    ()=>manualLink.ownershipDecision(
        { customer_id:'customer-stripe-b', email:'second@example.com' },
        { provider:'stripe', providerCustomerId:'cus_shared', email:'different@example.com' },
        ['customer-stripe-a']
    ),
    /already mapped to another CAPTAiNFiN customer/,
    'a Stripe cus_ identity must remain strictly one-to-one'
);
assert.strictEqual(
    manualLink.ownershipDecision(
        { customer_id:'customer-paypal-b', email:'same@example.com' },
        { provider:'paypal', providerCustomerId:'PAYER-SHARED', email:'same@example.com' },
        ['customer-paypal-a']
    ).verified,
    true,
    'matching provider email may verify a shared PayPal payer while the exact I- subscription remains the mutation target'
);

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
    source: 'stripe', billing_mode: 'subscription', provider_subscription_id: null, provider_customer_id: null,
    email: 'premium@example.com', plan_name: 'Premium Monthly', plan_code: 'premium-monthly'
};
let matches = discovery.matchPremiumRows([local], [stripe], baseContext());
assert.strictEqual(matches.length, 1);
assert.strictEqual(matches[0].state, 'safe');
assert.strictEqual(matches[0].match.id, 'sub_live');
assert(/Exact plan/.test(matches[0].reason));


const sharedPayPalContext=baseContext();
sharedPayPalContext.providerIdentityToCustomers.set('paypal:PAYER-1',new Set(['customer-2','customer-other']));
const localPayPal={
    ...local,
    source:'paypal',
    billing_mode:'subscription',
    customer_id:'customer-2',
    subscription_id:'local-paypal-2',
    plan_id:'plan-premium-paypal',
    email:'paypal@example.com'
};
matches=discovery.matchPremiumRows([localPayPal],[paypal],sharedPayPalContext);
assert.strictEqual(matches[0].state,'safe',
    'shared PayPal payer identity must fall through to unique customer email instead of blocking safe exact-plan discovery');
assert.match(matches[0].reason,/unique customer email/);
const sharedPayPalNoEmail=baseContext();
sharedPayPalNoEmail.providerIdentityToCustomers.set('paypal:PAYER-1',new Set(['customer-2','customer-other']));
sharedPayPalNoEmail.emailToCustomers.set('paypal@example.com',new Set(['customer-2','customer-other']));
matches=discovery.matchPremiumRows([localPayPal],[paypal],sharedPayPalNoEmail);
assert.strictEqual(matches[0].state,'unresolved',
    'shared PayPal payer identity without unique customer-specific evidence must never be auto-linked');

const duplicate = { ...stripe, id: 'sub_live_2' };
matches = discovery.matchPremiumRows([local], [stripe, duplicate], baseContext());
assert.strictEqual(matches[0].state, 'ambiguous', 'two live exact matches must never be guessed');
assert.strictEqual(matches[0].match, null);

const conflictContext = baseContext();
conflictContext.providerSubscriptionOwners.set('stripe:sub_live', { subscriptionIds: new Set(['some-other-local-sub']), customerIds: new Set(['someone-else']) });
matches = discovery.matchPremiumRows([local], [stripe], conflictContext);
assert.strictEqual(matches[0].state, 'conflict', 'a remote subscription already owned locally must never be stolen');

const identityMismatch = baseContext();
identityMismatch.providerIdentityToCustomers.set('stripe:cus_1', new Set(['different-customer']));
matches = discovery.matchPremiumRows([local], [stripe], identityMismatch);
assert.strictEqual(matches[0].state, 'unresolved', 'a known provider-customer-ID mismatch must never be overridden by matching email');

matches = discovery.matchPremiumRows([{ ...local, source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'sub_existing' }], [stripe], baseContext());
assert.strictEqual(matches[0].state, 'linked', 'already-linked premium users must not be rewritten');

matches = discovery.matchPremiumRows([{ ...local, source: 'stripe', billing_mode: 'subscription', provider_subscription_id: 'pi_legacy_wrong_object' }], [stripe], baseContext());
assert.strictEqual(matches[0].state, 'safe', 'a legacy PaymentIntent stored as the recurring ID must be offered for verified provider-link repair');
assert.strictEqual(matches[0].match.id, 'sub_live');

matches = discovery.matchPremiumRows([{ ...local, source: 'stripe', billing_mode: 'subscription', provider_subscription_id: ' sub_existing ' }], [stripe], baseContext());
assert.notStrictEqual(matches[0].state, 'linked', 'a whitespace-corrupted stored provider ID must not be hidden as a healthy recurring link');

matches = discovery.matchPremiumRows([{ ...local, commercial_snapshot:{ providerLinkDisposition:'ending' }, cancel_at_period_end:true }], [stripe], baseContext());
assert.strictEqual(matches[0].state, 'ending', 'an explicitly marked paid term intentionally ending after the current period must be removed from provider-link work');
assert.strictEqual(matches[0].match, null, 'an intentionally ending paid term must never be auto-linked even when a provider candidate exists');

matches = discovery.matchPremiumRows([local], [{ ...stripe, status: 'canceled' }], baseContext());
assert.strictEqual(matches[0].state, 'unresolved', 'cancelled Stripe subscriptions must not be used to justify premium access');

assert.strictEqual(adminBilling.recurringProblems({ subscriptions: [{ recurring:true,billing_mode:'subscription',source:'stripe',provider_subscription_id:'sub_valid',status:'past_due',cancel_at_period_end:true,last_error:null }] }).length, 0, 'past-due subscriptions intentionally ending after the current period must not stay in the operator problem queue');
assert.strictEqual(adminBilling.recurringProblems({ subscriptions: [{ recurring:true,billing_mode:'subscription',source:'stripe',provider_subscription_id:'sub_valid',status:'past_due',cancel_at_period_end:false,last_error:null }] }).length, 1, 'past-due subscriptions still expected to renew must remain operator work');
assert.strictEqual(adminBilling.recurringProblems({ subscriptions: [{ recurring:true,billing_mode:'subscription',source:'stripe',provider_subscription_id:'sub_valid',status:'past_due',cancel_at_period_end:true,last_error:'provider sync failed' }] }).length, 1, 'provider sync failures must remain operator work even when renewal is stopped');

const discoverySource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'subscription-discovery.js'), 'utf8');
const unlinkedPaidTermSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'unlinked-paid-term.js'), 'utf8');
const lifecycleSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'lifecycle.js'), 'utf8');
const manualSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'payments', 'manual-subscription-link.js'), 'utf8');
assert.ok(!discoverySource.includes("e.server_class='premium'"), 'paid provider-link discovery must not depend on the legacy media server class when explicit plan pools are authoritative');
assert.ok(!unlinkedPaidTermSource.includes("row.effective_server_class !== 'premium'"), 'operator classification of paid fixed terms must not depend on the legacy media server class');
assert.ok(unlinkedPaidTermSource.includes("['jellyfin','emby','bundle']"), 'operator fixed-term billing disposition must cover every paid media service included by provider discovery');
assert.ok(discoverySource.includes("IN ('jellyfin','emby','bundle')"), 'provider-link discovery must cover every paid media service that can use recurring Stripe/PayPal billing');
assert.ok(discoverySource.includes("COALESCE(e.price_minor_snapshot,e.price_minor,0)>0") && discoverySource.includes("COALESCE(e.is_free_tier,FALSE)=FALSE"), 'paid/non-Free commercial state must define provider-link discovery eligibility');
assert.ok(discoverySource.includes("IN('manual','admin_grant')") && discoverySource.includes("provider_subscription_id"), 'billing coverage SQL must classify historical provider-less manual grants consistently with the JavaScript fixed-term logic');
assert.ok(discoverySource.includes('s.commercial_snapshot'), 'provider-link classification must load the persisted paid-term disposition');
assert.ok(discoverySource.includes("status: 'all'"), 'Stripe discovery must inspect all subscriptions before selecting current states');
assert.ok(discoverySource.includes("PAYPAL_TRANSACTION_TYPES = Object.freeze(['T0002', 'T0003'])"), 'PayPal discovery must cover subscription and preapproved recurring payments');
assert.ok(discoverySource.includes("paypal_reference_id_type || '').toUpperCase() === 'SUB'"), 'PayPal discovery must only treat SUB references as subscription IDs');
assert.ok(discoverySource.includes("state: 'ending'"), 'subscription discovery must classify explicitly fixed paid terms as reference-only');
assert.ok(discoverySource.includes("COUNT(*) FILTER(WHERE NOT linked AND NOT ending)::int AS missing"), 'coverage stats must aggregate provider-link integrity in SQL instead of materializing every premium customer row');
assert.ok(discoverySource.includes('provider_subscription_id IS NOT DISTINCT FROM BTRIM(provider_subscription_id)'), 'coverage stats must classify whitespace-corrupted provider IDs as missing/repairable rather than linked');
assert.ok(discoverySource.includes("COALESCE(commercial_snapshot->'migrated'='true'::jsonb,FALSE)"), 'coverage SQL must treat a missing commercial snapshot as non-legacy, matching JavaScript fixed-term classification');
assert.ok(!/async function coverageStats\(\)[\s\S]{0,200}premiumEntitlements\(\)/.test(discoverySource), 'coverage stats must not load the full premium entitlement identity rowset merely to count billing states');
assert.ok(!/activatePurchase\s*\(/.test(discoverySource), 'subscription discovery must attach provider billing to existing premium entitlements, never create a new entitlement');
assert.ok(!/\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+subscriptions\b/i.test(discoverySource), 'discovery must not mutate provider-backed subscriptions outside the lifecycle owner');
assert.ok(discoverySource.includes("require('./lifecycle')"), 'discovery must delegate provider-backed linking to the canonical lifecycle owner');
assert.ok(discoverySource.includes("require('./provider-financial-state')") && discoverySource.includes("financialState.providerIdentityRows(['stripe','paypal'])"), 'subscription discovery must consume the canonical provider identity projection instead of querying payment_customers independently');
assert.ok(discoverySource.includes('financialState.paypalSubscriptionReferences()'), 'stored PayPal subscription references must come from the canonical financial read model');
assert.ok(discoverySource.includes('subscriptionIds:new Set()') && discoverySource.includes('owners.subscriptionIds.add') && discoverySource.includes('[...owner.subscriptionIds].some'), 'discovery must preserve every normalized provider-subscription owner so historical duplicates cannot be hidden by Map overwrite order');
assert.ok(lifecycleSource.includes('attachDiscoveredProviderSubscription'), 'lifecycle must own discovered provider-subscription attachment');
assert.ok(lifecycleSource.includes('assertNoOtherLiveRecurring'), 'lifecycle attachment must preserve the one-live-recurring-primary invariant');
assert.ok(lifecycleSource.includes('oldDelinquencyKey') && lifecycleSource.includes('oldDelinquencyKey !== newDelinquencyKey') && lifecycleSource.includes('otherLiveOwner') && lifecycleSource.includes("s.status IN('active','trialing','past_due','paused')") && lifecycleSource.includes("status: 'active'"), 'provider-link repair must move stale delinquency authority without releasing a shared old hold while any duplicate live recurring owner still depends on it');
assert.ok(lifecycleSource.includes('state.recurringProvider(local) && validRemoteRecurringId(local.source, local.provider_subscription_id)'), 'lifecycle must allow repair when billing_mode says recurring but the stored provider object is not a real recurring subscription');
assert.ok(/plan_id=\$2[\s\S]*external_id=ANY\(\$3::text\[\]\)/.test(lifecycleSource), 'lifecycle must snapshot the exact remote price/plan that maps to the existing premium plan');

assert.ok(manualSource.includes("require('./subscription-discovery')"), 'manual recovery must reuse canonical premium/discovery normalization');
assert.ok(manualSource.includes("require('./lifecycle')"), 'manual recovery must delegate the write to lifecycle');
assert.ok(manualSource.includes("require('./provider-financial-state')") && manualSource.includes('financialState.providerIdentityOwners'), 'manual provider-link verification must reuse the canonical provider identity reader');
assert.ok(manualSource.includes('attachDiscoveredProviderSubscription'), 'manual recovery must use the same canonical attachment owner as automatic discovery');
assert.ok(manualSource.includes("checkout_mode='subscription' AND plan_id=$2"), 'manual recovery must verify exact local plan mapping');
assert.ok(manualSource.includes("LOWER(BTRIM(COALESCE(source,'')))=$1") && manualSource.includes("BTRIM(COALESCE(provider_subscription_id,''))=$2"), 'manual recovery preview must reject normalized provider-ID ownership conflicts before mutation');
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
assert.ok(adminSource.includes('premiumRows.filter(discovery.needsProviderLink)'), 'Billing must only queue unlinked premium customers that still require recurring-provider recovery');
assert.ok(adminSource.includes('premiumRows.filter(discovery.endingWithoutRenewal)'), 'Billing must keep fixed/ending paid terms in a separate reference section');
assert.ok(adminSource.includes('Paid terms ending without renewal'), 'Billing must visibly label the reference-only non-renewing paid-term section');
assert.ok(adminSource.includes('No action required.'), 'non-renewing paid terms must be explicitly labelled as requiring no operator action');
assert.ok(adminSource.includes('/admin/billing/:id/manual-preview'), 'each missing link must support read-only provider verification');
assert.ok(adminSource.includes('/admin/billing/:id/manual-link'), 'each missing link must support explicit verified attachment');
assert.ok(adminSource.includes('Verify provider subscription'), 'manual resolution must show provider truth before attachment');
assert.ok(adminSource.includes('/manual-preview#manual-provider-preview'), 'manual verification submissions must target the rendered verification feedback instead of returning the operator to the page top');
assert.ok(adminSource.includes('data-native-submit="true"'), 'manual provider verification must use native navigation so server-rendered 400 details are not swallowed by generic AJAX form feedback');
assert.ok(adminSource.includes('Subscription verification failed'), 'manual verification failures must be visibly rendered in the same operator workflow');
assert.ok(adminSource.includes('Provider verification succeeded.'), 'successful manual provider verification must have explicit visible feedback before linking');
assert.ok(adminSource.includes('manualAttempt'), 'manual verification errors must preserve enough attempted-provider context to explain what failed');
assert.ok(adminSource.includes('${verification}${table}'), 'manual verification feedback must render before the missing-subscription table, not after the full page');
assert.ok(adminSource.includes("row.status==='past_due'&&!row.cancel_at_period_end"), 'intentional end-of-period cancellations must not remain in the urgent past-due queue');
assert.ok(adminSource.includes("filter(item=>item.state!=='linked'&&item.state!=='ending')"), 'automatic discovery results must omit both healthy linked rows and fixed-term reference rows');
assert.ok(adminSource.includes('Recurring subscriptions'), 'linked recurring subscriptions must remain available as secondary/reference information');
assert.ok(adminSource.includes('csrf.verify(req)'), 'discovery and manual recovery mutations must be CSRF protected');

console.log('Subscription discovery smoke passed.');
