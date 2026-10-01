'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const providerLifecycleState = require('../src/payments/provider-lifecycle-state');

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


assert.strictEqual(providerLifecycleState.normalizeStatus('stripe',' ACTIVE '),'active');
assert.strictEqual(providerLifecycleState.normalizeStatus('paypal',' cancelled '),'CANCELLED');
assert.strictEqual(providerLifecycleState.normalizeStatus('plisio',' Pending Internal '),'pending internal');
assert.strictEqual(providerLifecycleState.isTerminal('stripe','incomplete_expired'),true);
assert.strictEqual(providerLifecycleState.isTerminal('paypal','canceled'),true);
assert.strictEqual(providerLifecycleState.isTerminal('plisio','mismatch'),true);
assert.strictEqual(providerLifecycleState.isWaiting('plisio','pending'),true);
assert.strictEqual(providerLifecycleState.isHealthy('paypal','active'),true);
assert.throws(()=>providerLifecycleState.normalizeStatus('unknown','active'),/Unsupported payment provider/);

const stripeSource=read('src/payments/stripe.js');
const paypalSource=read('src/payments/paypal.js');
const plisioSource=read('src/payments/plisio.js');
const billingControlSource=read('src/payments/billing-control.js');
const checkoutRecoverySource=read('src/payments/provider-checkout-recovery.js');
for(const [name,source] of [
    ['Stripe',stripeSource],
    ['PayPal',paypalSource],
    ['Plisio',plisioSource],
    ['checkout recovery',checkoutRecoverySource]
]){
    assert(source.includes("provider-lifecycle-state"),`${name} must consume the canonical provider lifecycle state contract`);
}
assert(billingControlSource.includes("provider-contract"),'billing control must consume provider lifecycle facts through the canonical provider contract');
assert(!billingControlSource.includes("provider-lifecycle-adapters"),'billing policy must not bypass the canonical provider contract');
assert(!billingControlSource.includes("['canceled', 'cancelled', 'incomplete_expired']")
    && !billingControlSource.includes("['CANCELLED', 'CANCELED', 'EXPIRED']"),
    'billing control must not duplicate provider terminal-state lists');
assert(!stripeSource.includes("['canceled','cancelled','incomplete_expired']"),
    'Stripe integration must not duplicate terminal-state classification');
assert(!paypalSource.includes("['CANCELLED','CANCELED','EXPIRED'].includes(paypalStatus(status))"),
    'PayPal integration must not duplicate terminal-state classification');

// billing_mode remains the application-level authority. The database migration
// repairs and rejects the one impossible Stripe tuple (subscription + pi_*), so
// provider-shape heuristics do not leak into the general policy engine.
const integrityRepair = read('db/migrations/20260910234000_payment_integrity_repair.sql');
assert(integrityRepair.includes("COALESCE(NEW.provider_subscription_id,'') ~* '^pi_'"), 'billing-mode trigger must self-heal Stripe PaymentIntent rows');
assert(integrityRepair.includes('UPDATE OF source,commercial_snapshot,billing_mode,provider_subscription_id'), 'billing-mode trigger must react when the provider identity changes');
assert(integrityRepair.includes("SET billing_mode='payment'"), 'historical Stripe PaymentIntent rows must be repaired to payment mode');
assert(integrityRepair.includes("failure_kind='superseded'"), 'impossible historical renewal operations must be retired as superseded');
assert(integrityRepair.includes('manual_review_required=FALSE'), 'retired impossible renewal operations must leave the manual-review queue');
assert(integrityRepair.includes('subscriptions_stripe_recurring_provider_id_check'), 'database must reject future Stripe subscription/payment identity contradictions');

console.log('provider recovery safety smoke: ok');
