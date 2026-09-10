'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const billingMode = require('../src/payments/subscription-billing-mode');

function read(relativePath) {
    return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

const providerRecoverySource = read('src/payments/provider-operation-recovery.js');
const matching = providerRecoverySource.match(/async function matchingSchedule\([\s\S]*?\n\}/)?.[0] || '';
const missing = providerRecoverySource.match(/function stripeResourceMissing\([\s\S]*?\n\}/)?.[0] || '';

assert(matching, 'provider recovery must retain a dedicated recorded-schedule lookup helper');
assert(missing, 'provider recovery must classify Stripe resource-missing errors explicitly');
assert(missing.includes('status === 404'), 'HTTP 404 may be treated as a genuinely missing Stripe schedule');
assert(missing.includes("code === 'resource_missing'"), 'Stripe resource_missing may be treated as a genuinely missing schedule');
assert(!matching.includes('catch (_) {}'), 'recorded Stripe schedule lookup must never swallow all provider errors');
assert.match(matching, /catch \(error\)[\s\S]*if \(!stripeResourceMissing\(error\)\) throw error;/, 'timeouts, 5xx, auth and network failures must propagate into provider-operation retry handling');

assert.strictEqual(
    billingMode.isRecurring({ source:'stripe', billing_mode:'subscription', provider_subscription_id:'sub_live_123' }),
    true,
    'Stripe sub_* identities must remain eligible for recurring billing control'
);
assert.strictEqual(
    billingMode.isRecurring({ source:'stripe', billing_mode:'subscription', provider_subscription_id:'pi_oneoff_123' }),
    false,
    'Stripe pi_* PaymentIntent identities must never enter recurring subscription control'
);
assert.strictEqual(
    billingMode.providerIdentityContradictsRecurring({ source:'stripe', provider_subscription_id:'PI_ONEOFF_123' }),
    true,
    'Stripe PaymentIntent contradiction guard must be case-insensitive'
);

const integrityRepair = read('db/migrations/20260910234000_payment_integrity_repair.sql');
assert(integrityRepair.includes("COALESCE(NEW.provider_subscription_id,'') ~* '^pi_'"), 'billing-mode trigger must self-heal Stripe PaymentIntent rows');
assert(integrityRepair.includes('UPDATE OF source,commercial_snapshot,billing_mode,provider_subscription_id'), 'billing-mode trigger must react when the provider identity changes');
assert(integrityRepair.includes("failure_kind='superseded'"), 'impossible historical renewal operations must be retired as superseded');
assert(integrityRepair.includes('manual_review_required=FALSE'), 'retired impossible renewal operations must leave the manual-review queue');
assert(integrityRepair.includes('subscriptions_stripe_recurring_provider_id_check'), 'database must reject future Stripe subscription/payment identity contradictions');

console.log('provider recovery safety smoke: ok');
