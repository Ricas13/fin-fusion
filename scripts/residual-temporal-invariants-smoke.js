'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const paypal = require('../src/payments/paypal');
const provisioning = require('../src/jellyfin/resilient-provisioning');

function source(relative) {
    return fs.readFileSync(path.join(__dirname, '..', relative), 'utf8');
}

function section(text, start, end) {
    const from = text.indexOf(start);
    if (from < 0) throw new Error(`Missing source marker: ${start}`);
    const to = end ? text.indexOf(end, from + start.length) : text.length;
    return text.slice(from, to < 0 ? text.length : to);
}

function expectThrows(fn, code) {
    let error = null;
    try { fn(); } catch (caught) { error = caught; }
    assert(error, 'Expected operation to throw.');
    if (code) assert.strictEqual(error.code, code, `Unexpected error code: ${error.code}`);
    return error;
}

function main() {
    const deletionMigration = source('db/migrations/20260829193000_preserve_affiliate_history_on_customer_delete.sql');
    assert.match(deletionMigration, /CREATE OR REPLACE FUNCTION public\.finalize_customer_deletion/);
    assert.doesNotMatch(deletionMigration, /DELETE FROM public\.affiliate_credit_ledger\s+WHERE referred_customer_id=j\.customer_id/);
    assert.match(deletionMigration, /Do NOT delete affiliate_credit_ledger rows/);

    const lifecycle = source('src/payments/lifecycle-primitives.js');
    const activation = section(lifecycle, 'async function activatePurchase', 'async function updateProviderSubscription');
    for (const required of [
        'settlementCheckoutIntentId',
        'await assertSettlementCheckout',
        'await capacity.lockAndAssert',
        'excludeCheckoutIntentId',
        "error?.code === 'PLAN_CAPACITY_EXHAUSTED'",
        'recordCapacitySettlementIncident',
        "incident_type='checkout_completion'",
        'paidButUnfulfilled'
    ]) {
        assert(activation.includes(required) || lifecycle.includes(required), `Paid activation is missing ${required}`);
    }
    const checkout = source('src/payments/checkout-intents.js');
    assert(checkout.includes('checkoutIntentId:row.id'), 'Verified checkout contract does not carry exact settlement identity.');
    const capacity = source('src/entitlements/plan-capacity.js');
    assert(capacity.includes('excludeCheckoutIntentId'), 'Capacity accounting cannot exclude the exact settling checkout.');
    assert(capacity.includes("error.code='PLAN_CAPACITY_EXHAUSTED'"), 'Capacity exhaustion is not machine-classified.');

    assert.strictEqual(paypal.paypalHealthy('ACTIVE'), true);
    assert.strictEqual(paypal.paypalHealthy('SUSPENDED'), false);
    assert.strictEqual(paypal.paypalTerminal('CANCELLED'), true);
    assert.strictEqual(paypal.paypalTerminal('EXPIRED'), true);
    assert.strictEqual(paypal.paypalTerminal('ACTIVE'), false);
    const paypalSource = source('src/payments/paypal.js');
    const webhook = section(paypalSource, 'async function handleWebhookEvent', 'async function processClaimedEvent');
    assert(webhook.includes("case 'BILLING.SUBSCRIPTION.CANCELLED':case 'BILLING.SUBSCRIPTION.SUSPENDED':case 'BILLING.SUBSCRIPTION.EXPIRED':if(resource.id)await syncCurrentSubscription(resource.id,{activateMissing:false})"), 'Negative PayPal subscription webhooks are not reconciled from current provider state without creating missing access.');
    const denied = section(webhook, "case 'PAYMENT.SALE.DENIED'", "case 'PAYMENT.SALE.REFUNDED'");
    assert(denied.includes('await syncCurrentSubscription(subscriptionId,{activateMissing:false})'), 'PayPal denied sale does not fetch current subscription state first without activating missing access.');
    assert(denied.includes('paypalHealthy(synced.providerStatus)'), 'PayPal delayed denial cannot detect a recovered active subscription.');
    assert(denied.includes('failedRenewals.resolveOpen'), 'Recovered/terminal PayPal renewal incidents are not settled.');
    assert(denied.includes('failedRenewals.record'), 'Current PayPal delinquency is not durably recorded through the canonical failed-renewal owner.');
    assert(!denied.includes("providerStatus:'suspended'"), 'Delayed PayPal sale denial can still force local suspension from event order alone.');

    const planChange = source('src/payments/customer-plan-change.js');
    assert(planChange.includes("timeout:providerHttp.timeoutMs('stripe')"), 'Stripe plan-change calls must use the canonical provider HTTP deadline.');
    const immediate = section(planChange, 'async function setStripePlan', 'async function createLocalChange');
    assert(immediate.includes('let providerMutationAttempted=false'), 'Immediate Stripe plan changes must track whether a remote mutation may have happened.');
    assert(immediate.includes('providerMutationAttempted=true;const updated=await client.subscriptions.update'), 'Immediate Stripe mutation ambiguity is not marked before the provider call.');
    assert(immediate.includes('const synced=await billingControl.syncSubscription(subscriptionId);if(!synced.ok)throw new Error'), 'Immediate Stripe plan change can still be declared reconciled after provider verification fails.');
    assert(immediate.includes('error.planChangeRefusal&&!providerMutationAttempted?{terminal:true}:{}'), 'Ambiguous post-provider Stripe plan-change failures are still forced terminal instead of entering recovery.');
    const scheduled = section(planChange, 'async function scheduleStripeProvider', 'async function requestChange');
    assert(scheduled.includes('let providerMutationAttempted=false'), 'Scheduled Stripe plan changes must track possible provider mutation.');
    assert(scheduled.includes('providerMutationAttempted=true;schedule=await client.subscriptionSchedules.create'), 'Stripe schedule creation ambiguity is not routed into provider-operation recovery.');
    assert(scheduled.includes('providerMutationAttempted=true;const updated=await client.subscriptionSchedules.update'), 'Stripe schedule update ambiguity is not routed into provider-operation recovery.');
    assert(scheduled.includes('error.planChangeRefusal&&!providerMutationAttempted?{terminal:true}:{}'), 'Scheduled Stripe post-provider failures are still forced terminal.');

    assert.deepStrictEqual(provisioning.assertDiscordSyncResult({ added: [], removed: [], errors: [] }).errors, []);
    const discordError = expectThrows(() => provisioning.assertDiscordSyncResult({ errors: ['remove role: HTTP 503'] }), 'DISCORD_ROLE_SYNC_FAILED');
    assert.match(discordError.message, /Discord role synchronization failed/);
    const provisioningSource = source('src/jellyfin/resilient-provisioning.js');
    const reconcile = section(provisioningSource, 'async function reconcileCustomerUnlocked', 'async function reconcileCustomer');
    assert(reconcile.includes('assertDiscordSyncResult(await discordRoles.syncRoleForCustomer'), 'Discord role sync is not awaited by the canonical reconciliation owner.');
    assert(!/syncRoleForCustomer\([^\n]+\)\.catch\(/.test(reconcile), 'Discord role failure is still fire-and-forget.');
    assert(reconcile.includes('primaryEntitlement&&!primaryEntitlement.blocked'), 'Blocked primary entitlement can still request a managed Discord role.');
    assert(reconcile.includes('freeEntitlement&&!freeEntitlement.blocked'), 'Blocked Free entitlement can still request a managed Discord role.');

    console.log('Residual temporal invariant fast smoke passed.');
}

main();
