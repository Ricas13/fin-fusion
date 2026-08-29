'use strict';

const fs = require('fs');
const path = require('path');
const reconciliation = require('../src/payments/incident-reconciliation');
const incidents = require('../src/payments/incidents');
const stripe = require('../src/payments/stripe');

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
    // Current verified provider state is authoritative over a historical event:
    // terminal subscriptions stay terminal and already-recovered subscriptions
    // must not be regressed by a delayed invoice.payment_failed delivery.
    if (stripe.effectiveSyncStatus('canceled', 'past_due') !== 'canceled') {
        throw new Error('A late Stripe payment failure can regress canceled access back to past_due.');
    }
    if (stripe.effectiveSyncStatus('incomplete_expired', 'active') !== 'incomplete_expired') {
        throw new Error('A late Stripe paid event can resurrect an incomplete-expired subscription.');
    }
    if (stripe.effectiveSyncStatus('active', 'past_due') !== 'active') {
        throw new Error('A late historical Stripe payment failure can regress a currently-active subscription.');
    }
    if (stripe.effectiveSyncStatus('past_due', 'past_due') !== 'past_due') {
        throw new Error('A currently-delinquent Stripe subscription must still remain past_due.');
    }

    // One Stripe invoice can emit several invoice.payment_failed events while
    // Smart Retries run. Those retries must remain one operational incident and
    // a terminal subscription event must settle the incident automatically.
    const stripeSource = fs.readFileSync(require.resolve('../src/payments/stripe'), 'utf8');
    const renewalSource = fs.readFileSync(require.resolve('../src/payments/failed-renewals'), 'utf8');
    const renewalMigration = fs.readFileSync(path.join(__dirname, '../db/migrations/039_failed_renewal_incident_lifecycle.sql'), 'utf8');
    for (const required of [
        "failedRenewals.record",
        "failedRenewals.resolveOpen",
        "terminalStripeStatus(synced.providerStatus)"
    ]) {
        if (!stripeSource.includes(required)) throw new Error(`Stripe renewal lifecycle is missing ${required}`);
    }
    if (!renewalSource.includes("ON CONFLICT (provider,provider_case_id,incident_type)")) {
        throw new Error('Repeated failed-renewal provider events are not deduplicated by invoice/case.');
    }
    if (!renewalMigration.includes('payment_incidents_one_open_failed_renewal_case')) {
        throw new Error('Failed-renewal retry dedupe is missing its database concurrency guard.');
    }
    if (!renewalMigration.includes("event_type='customer.subscription.deleted'")) {
        throw new Error('Existing historical Stripe cancellation incidents are not retired during upgrade.');
    }

    // Grandfathering is continuity-only: hidden plans cannot be newly acquired,
    // while an already-linked recurring provider subscription can still be
    // synchronized by provider_subscription_id until it ends.
    const lifecycleSource = fs.readFileSync(require.resolve('../src/payments/lifecycle'), 'utf8');
    const primitivesSource = fs.readFileSync(require.resolve('../src/payments/lifecycle-primitives'), 'utf8');
    if (!lifecycleSource.includes(".visible=TRUE")) {
        throw new Error('Hidden legacy plans can accidentally re-enter new customer acquisition.');
    }
    if (!primitivesSource.includes("WHERE source=$4 AND provider_subscription_id=$5")) {
        throw new Error('Existing grandfathered provider subscriptions no longer synchronize independently of plan visibility.');
    }

    console.log('Payment incident safety smoke test passed.');
}

main();
