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
    // Hard deletion must preserve another customer's economic history. The
    // runtime migration replaces the SECURITY DEFINER finalizer and relies on
    // the existing ON DELETE SET NULL FK to pseudonymize the referred identity.
    const deletionMigration = source('db/migrations/20260829193000_preserve_affiliate_history_on_customer_delete.sql');
    assert.match(deletionMigration, /CREATE OR REPLACE FUNCTION public\.finalize_customer_deletion/);
    assert.doesNotMatch(deletionMigration, /DELETE FROM public\.affiliate_credit_ledger\s+WHERE referred_customer_id=j\.customer_id/);
    assert.match(deletionMigration, /Do NOT delete affiliate_credit_ledger rows/);

    // The actual paid activation owner, not an unrelated lifecycle function,
    // must re-check capacity after provider settlement. Its own still-live
    // checkout reservation is excluded by exact ID so a legitimate final slot
    // can settle, while an expired reservation cannot mask later occupancy.
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

    // Current provider state beats PayPal webhook delivery order.
    assert.strictEqual(paypal.paypalHealthy('ACTIVE'), true);
    assert.strictEqual(paypal.paypalHealthy('SUSPENDED'), false);
    assert.strictEqual(paypal.paypalTerminal('CANCELLED'), true);
    assert.strictEqual(paypal.paypalTerminal('EXPIRED'), true);
    assert.strictEqual(paypal.paypalTerminal('ACTIVE'), false);
    const paypalSource = source('src/payments/paypal.js');
    const webhook = section(paypalSource, 'async function handleWebhookEvent', 'async function processClaimedEvent');
    assert(webhook.includes("case 'BILLING.SUBSCRIPTION.CANCELLED':case 'BILLING.SUBSCRIPTION.SUSPENDED':case 'BILLING.SUBSCRIPTION.EXPIRED':if(resource.id)await syncCurrentSubscription(resource.id)"), 'Negative PayPal subscription webhooks are not reconciled from current provider state.');
    const denied = section(webhook, "case 'PAYMENT.SALE.DENIED'", "case 'PAYMENT.SALE.REFUNDED'");
    assert(denied.includes('await syncCurrentSubscription(subscriptionId)'), 'PayPal denied sale does not fetch current subscription state first.');
    assert(denied.includes('paypalHealthy(synced.providerStatus)'), 'PayPal delayed denial cannot detect a recovered active subscription.');
    assert(denied.includes('failedRenewals.resolveOpen'), 'Recovered/terminal PayPal renewal incidents are not settled.');
    assert(denied.includes('failedRenewals.record'), 'Current PayPal delinquency is not durably recorded through the canonical failed-renewal owner.');
    assert(!denied.includes("providerStatus:'suspended'"), 'Delayed PayPal sale denial can still force local suspension from event order alone.');

    // Discord failures must participate in the durable customer provisioning
    // retry state rather than being swallowed as a healthy reconcile.
    assert.deepStrictEqual(provisioning.assertDiscordSyncResult({ added: [], removed: [], errors: [] }).errors, []);
    const discordError = expectThrows(() => provisioning.assertDiscordSyncResult({ errors: ['remove role: HTTP 503'] }), 'DISCORD_ROLE_SYNC_FAILED');
    assert.match(discordError.message, /Discord role synchronization failed/);
    const provisioningSource = source('src/jellyfin/resilient-provisioning.js');
    const reconcile = section(provisioningSource, 'async function reconcileCustomerUnlocked', 'async function reconcileCustomer');
    assert(reconcile.includes('assertDiscordSyncResult(await discordRoles.syncRoleForCustomer'), 'Discord role sync is not awaited by the canonical reconciliation owner.');
    assert(!reconcile.includes("syncRoleForCustomer(customerId").includes?.('.catch('), 'invalid test guard');
    assert(!/syncRoleForCustomer\([^\n]+\)\.catch\(/.test(reconcile), 'Discord role failure is still fire-and-forget.');
    assert(reconcile.includes('primaryEntitlement&&!primaryEntitlement.blocked'), 'Blocked primary entitlement can still request a managed Discord role.');
    assert(reconcile.includes('freeEntitlement&&!freeEntitlement.blocked'), 'Blocked Free entitlement can still request a managed Discord role.');

    console.log('Residual temporal invariant fast smoke passed.');
}

main();
