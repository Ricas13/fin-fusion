'use strict';

const fs = require('fs');
const reconciliation = require('../src/payments/incident-reconciliation');
const incidents = require('../src/payments/incidents');

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

    console.log('Payment incident safety smoke test passed.');
}

main();
