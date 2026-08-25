'use strict';

const fs = require('fs');
const stripe = require('../src/payments/stripe');

function main() {
    if (stripe.effectiveSyncStatus('canceled', 'past_due') !== 'canceled') {
        throw new Error('Terminal Stripe cancellation can be regressed by a late failed-invoice event.');
    }
    if (stripe.effectiveSyncStatus('incomplete_expired', 'active') !== 'incomplete_expired') {
        throw new Error('Terminal Stripe expiry can be resurrected by a late paid event.');
    }
    if (stripe.effectiveSyncStatus('active', 'past_due') !== 'past_due') {
        throw new Error('A genuine failed renewal no longer enters delinquency handling.');
    }

    const lifecycle = fs.readFileSync(require.resolve('../src/payments/lifecycle'), 'utf8');
    const primitives = fs.readFileSync(require.resolve('../src/payments/lifecycle-primitives'), 'utf8');
    const failed = fs.readFileSync(require.resolve('../src/payments/failed-renewals'), 'utf8');

    if (!lifecycle.includes('.visible=TRUE')) {
        throw new Error('Hidden legacy plans can be acquired as new purchases.');
    }
    if (!primitives.includes('WHERE source=$4 AND provider_subscription_id=$5')) {
        throw new Error('Existing recurring provider subscriptions no longer synchronize independently of storefront visibility.');
    }
    if (!failed.includes('ON CONFLICT (provider,provider_case_id,incident_type)')) {
        throw new Error('Repeated provider retries are not collapsed into one failed-renewal incident.');
    }

    console.log('Grandfathered subscription contract smoke test passed.');
}

main();
