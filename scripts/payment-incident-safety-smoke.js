'use strict';

const fs = require('fs');
const path = require('path');
const reconciliation = require('../src/payments/incident-reconciliation');
const incidents = require('../src/payments/incidents');
const stripe = require('../src/payments/stripe');
const paypal = require('../src/payments/paypal');
const primitives = require('../src/payments/lifecycle-primitives');

function expectThrows(fn, pattern) {
    let thrown = null;
    try { fn(); } catch (error) { thrown = error; }
    if (!thrown) throw new Error('Expected operation to throw.');
    if (pattern && !pattern.test(String(thrown.message || thrown))) {
        throw new Error(`Unexpected error: ${thrown.message}`);
    }
}

function main() {
    // Provider outcome interpretation must stay conservative. PayPal's seller
    // wins are explicit; accepting a buyer-favour or unresolved result here
    // would make the restore button unsafe.
    for (const outcome of [
        'RESOLVED_SELLER_FAVOR',
        'RESOLVED_SELLER_FAVOUR',
        'RESOLVED_WITH_PAYOUT',
        'CANCELED_BY_BUYER',
        'DENIED'
    ]) {
        if (!reconciliation.paypalMerchantWon(outcome)) {
            throw new Error(`Expected merchant-winning PayPal outcome: ${outcome}`);
        }
    }
    for (const outcome of ['RESOLVED_BUYER_FAVOR', 'RESOLVED_BUYER_FAVOUR', 'ACCEPTED', 'NONE', '', null]) {
        if (reconciliation.paypalMerchantWon(outcome)) {
            throw new Error(`Unsafe PayPal outcome accepted as merchant win: ${outcome}`);
        }
    }

    // A restore requires BOTH a local subscription match and a current provider
    // snapshot that explicitly marked the incident recoverable.
    const dispute = { incident_type: 'dispute' };
    incidents.restoreEvidenceAllowed(dispute, {
        match: { subscription_id: 'sub-local' },
        snapshot: { restoreEligible: true, providerStatus: 'won' }
    });
    expectThrows(() => incidents.restoreEvidenceAllowed(dispute, {
        match: { subscription_id: 'sub-local' },
        snapshot: { restoreEligible: false, providerStatus: 'under_review' }
    }), /does not prove recovery/i);
    expectThrows(() => incidents.restoreEvidenceAllowed(dispute, {
        match: null,
        snapshot: { restoreEligible: true }
    }), /did not match/i);
    expectThrows(() => incidents.restoreEvidenceAllowed({ incident_type: 'refund' }, {
        match: { subscription_id: 'sub-local' },
        snapshot: { restoreEligible: true }
    }), /refund incident cannot restore/i);

    // Identity binding prevents a provider reference from being used to restore
    // a different local customer than the incident was opened for.
    reconciliation.assertMatchIdentity(
        { scope: 'direct', customer_id: 'customer-a' },
        { scope: 'customer', owner_id: 'customer-a' }
    );
    expectThrows(() => reconciliation.assertMatchIdentity(
        { scope: 'direct', customer_id: 'customer-a' },
        { scope: 'customer', owner_id: 'customer-b' }
    ), /different customer/i);

    // A provider payment/subscription identity is immutable once it has a local
    // owner. No webhook or retry may silently rebind it to another user, plan,
    // or conflicting provider customer.
    const owned = { customer_id: 'customer-a', plan_id: 'plan-a', provider_customer_id: 'cus-a' };
    primitives.assertExistingProviderOwnership(owned, { customerId: 'customer-a', planId: 'plan-a', providerCustomerId: 'cus-a' });
    expectThrows(() => primitives.assertExistingProviderOwnership(owned, { customerId: 'customer-b', planId: 'plan-a', providerCustomerId: 'cus-a' }), /another CAPTAiNFiN customer/i);
    expectThrows(() => primitives.assertExistingProviderOwnership(owned, { customerId: 'customer-a', planId: 'plan-b', providerCustomerId: 'cus-a' }), /different CAPTAiNFiN plan/i);
    expectThrows(() => primitives.assertExistingProviderOwnership(owned, { customerId: 'customer-a', planId: 'plan-a', providerCustomerId: 'cus-b' }), /customer identity does not match/i);

    // Guard the original regression directly: reconciliation must query CURRENT
    // provider resources, rather than deciding from the immutable webhook event.
    const source = fs.readFileSync(require.resolve('../src/payments/incident-reconciliation'), 'utf8');
    for (const required of [
        '/v1/disputes/',
        '/v1/subscriptions/',
        '/v1/customer/disputes/',
        '/v1/billing/subscriptions/',
        'restoreEligible'
    ]) {
        if (!source.includes(required)) throw new Error(`Current-state provider verification is missing ${required}`);
    }
    if (!source.includes('scope=COALESCE($2,scope)')) {
        throw new Error('Provider reconciliation does not promote a matched unresolved incident to direct scope.');
    }

    // Generic provider status "resolved" is ambiguous (especially for PayPal):
    // only an explicitly merchant-winning webhook may use the automatic restore
    // path. A plain resolved status must preserve the existing hold until current
    // provider evidence proves recovery.
    const incidentSource = fs.readFileSync(require.resolve('../src/payments/incidents'), 'utf8');
    if (!incidentSource.includes("if(status==='won')action='restore'")) {
        throw new Error('Automatic incident restore is not restricted to explicit merchant wins.');
    }
    if (!incidentSource.includes("else if(status==='resolved')action='preserve'")) {
        throw new Error('Ambiguous resolved incidents are not forced to preserve access holds.');
    }

    // Stripe webhook delivery is not guaranteed to arrive in lifecycle order.
    // A stale invoice failure must never resurrect a subscription after Stripe
    // has already marked the grandfathered agreement terminal.
    if (stripe.effectiveSyncStatus('canceled', 'past_due') !== 'canceled') {
        throw new Error('A late Stripe payment failure can regress canceled access back to past_due.');
    }
    if (stripe.effectiveSyncStatus('incomplete_expired', 'active') !== 'incomplete_expired') {
        throw new Error('A late Stripe paid event can resurrect an incomplete-expired subscription.');
    }
    if (stripe.effectiveSyncStatus('active', 'past_due') !== 'past_due') {
        throw new Error('A genuine failed renewal is not allowed to mark an active Stripe subscription delinquent.');
    }

    // PayPal legacy agreements may predate CAPTAiNFiN custom_id metadata. They
    // are allowed to synchronize only after the exact I- provider ID has been
    // deterministically linked locally. Email is never an ownership fallback.
    const paypalSource = fs.readFileSync(require.resolve('../src/payments/paypal'), 'utf8');
    for (const required of [
        "WHERE source='paypal' AND provider_subscription_id=$1",
        'no exact local provider link',
        'syncExactLegacySubscription',
        'failedRenewals.record',
        'failedRenewals.resolveOpen',
        'paypalTerminalStatus(current.status)'
    ]) {
        if (!paypalSource.includes(required)) throw new Error(`PayPal exact-identity lifecycle is missing ${required}`);
    }
    if (/LOWER\([^\n]*email/i.test(paypalSource)) {
        throw new Error('PayPal lifecycle contains an unsafe email-based ownership fallback.');
    }
    const kept = paypal.laterPeriodEnd('2026-12-01T00:00:00Z', '2026-11-01T00:00:00Z');
    if (kept.toISOString() !== '2026-12-01T00:00:00.000Z') throw new Error('Legacy PayPal sync can shorten imported paid-through access.');
    const extended = paypal.laterPeriodEnd('2026-11-01T00:00:00Z', '2026-12-01T00:00:00Z');
    if (extended.toISOString() !== '2026-12-01T00:00:00.000Z') throw new Error('Legacy PayPal sync does not advance a later provider billing period.');

    // One Stripe/PayPal invoice or sale retry is one operational incident.
    const stripeSource = fs.readFileSync(require.resolve('../src/payments/stripe'), 'utf8');
    const renewalSource = fs.readFileSync(require.resolve('../src/payments/failed-renewals'), 'utf8');
    const renewalMigration = fs.readFileSync(path.join(__dirname, '../db/migrations/039_failed_renewal_incident_lifecycle.sql'), 'utf8');
    for (const required of [
        'failedRenewals.record',
        'failedRenewals.resolveOpen',
        'terminalStripeStatus(synced.providerStatus)'
    ]) {
        if (!stripeSource.includes(required)) throw new Error(`Stripe renewal lifecycle is missing ${required}`);
    }
    if (!renewalSource.includes('ON CONFLICT (provider,provider_case_id,incident_type)')) {
        throw new Error('Repeated failed-renewal provider events are not deduplicated by invoice/case.');
    }
    if (!renewalMigration.includes('payment_incidents_one_open_failed_renewal_case')) {
        throw new Error('Failed-renewal retry dedupe is missing its database concurrency guard.');
    }
    if (!renewalMigration.includes("event_type='customer.subscription.deleted'")) {
        throw new Error('Existing historical Stripe cancellation incidents are not retired during upgrade.');
    }

    // Plisio is one-time rather than recurring, but its signed callback must
    // resolve the CAPTaINFiN owner through the immutable local checkout intent,
    // never through provider-supplied email or display data.
    const plisioSource = fs.readFileSync(require.resolve('../src/payments/plisio'), 'utf8');
    for (const required of ['checkoutIntents.findById(intentId)', 'checkoutIntents.verifiedProviderContract', 'customerId:intent.owner_id']) {
        if (!plisioSource.includes(required)) throw new Error(`Plisio checkout ownership is missing ${required}`);
    }
    if (/LOWER\([^\n]*email/i.test(plisioSource)) throw new Error('Plisio callback contains an unsafe email-based ownership fallback.');

    // Cross-provider database and transaction boundaries must make identity
    // collisions impossible even if a caller supplies inconsistent IDs.
    const primitivesSource = fs.readFileSync(require.resolve('../src/payments/lifecycle-primitives'), 'utf8');
    for (const required of ['ensurePaymentCustomerTx(client', 'assertExistingProviderOwnership(existing.rows[0]', 'Provider customer is already linked to another CAPTAiNFiN customer']) {
        if (!primitivesSource.includes(required)) throw new Error(`Provider ownership transaction guard is missing ${required}`);
    }
    const baseline = fs.readFileSync(path.join(__dirname, '../db/migrations/000_database_baseline.sql'), 'utf8');
    if (!baseline.includes('subscriptions_source_provider_subscription_id_key UNIQUE (source, provider_subscription_id)')) {
        throw new Error('Provider subscription IDs are not unique per provider in the database.');
    }
    if (!baseline.includes('payment_customers_provider_provider_customer_id_key UNIQUE (provider, provider_customer_id)')) {
        throw new Error('Provider customer IDs are not unique per provider in the database.');
    }

    // Grandfathering is continuity-only: hidden plans cannot be newly acquired,
    // while an already-linked recurring provider subscription can still be
    // synchronized by provider_subscription_id until it ends.
    const lifecycleSource = fs.readFileSync(require.resolve('../src/payments/lifecycle'), 'utf8');
    if (!lifecycleSource.includes('.visible=TRUE')) {
        throw new Error('Hidden legacy plans can accidentally re-enter new customer acquisition.');
    }
    if (!primitivesSource.includes('WHERE source=$4 AND provider_subscription_id=$5')) {
        throw new Error('Existing grandfathered provider subscriptions no longer synchronize independently of plan visibility.');
    }

    console.log('Payment incident safety smoke test passed.');
}

main();
