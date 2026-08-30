'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const paypal = require('../src/payments/paypal');
const billingControl = require('../src/payments/billing-control');
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
        'paidButUnfulfilled',
        'historicalCheckoutReplay',
        "settlementIntent.state !== 'open'",
        'effectivePlanId: row.plan_id'
    ]) {
        assert(activation.includes(required) || lifecycle.includes(required), `Paid activation is missing ${required}`);
    }
    assert(lifecycle.includes('SELECT id,customer_id,plan_id,provider,state FROM billing_checkout_intents'), 'Settlement verification must load checkout state so terminal historical replays can be distinguished from open crash recovery.');
    assert(activation.indexOf('const settlementIntent = await assertSettlementCheckout') < activation.indexOf('historicalCheckoutReplay = Boolean'), 'Existing provider-subscription replay must lock and classify its settlement intent before deciding whether commercial state may be rewritten.');
    assert(activation.includes('if (historicalCheckoutReplay) {\n                    row = existingSubscription;'), 'A terminal historical checkout replay can still rewrite a later subscription contract.');
    assert(activation.includes('if (providerCustomerId && !historicalCheckoutReplay)'), 'Historical checkout replay can still regress provider-customer identity.');
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

    assert.strictEqual(billingControl.providerMissing({ statusCode: 404 }), true, 'Structured provider 404 must still count as confirmed missing.');
    assert.strictEqual(billingControl.providerMissing({ code: 'resource_missing' }), true, 'Stripe resource_missing must still count as confirmed missing.');
    assert.strictEqual(billingControl.providerMissing(new Error('No such subscription: sub_dead')), true, 'Stripe no-such-subscription must still count as confirmed missing.');
    assert.strictEqual(billingControl.providerMissing(new Error('upstream host not found')), false, 'Network/DNS not-found text must never be mistaken for a deleted billing subscription.');
    assert.strictEqual(billingControl.providerMissing(new Error('provider service does not exist')), false, 'Generic service errors must never authorize destructive local billing cleanup.');
    const billingSource = source('src/payments/billing-control.js');
    const renewal = section(billingSource, 'async function setRenewal', 'function recoveryManual');
    assert(renewal.includes('expectedCancelAtPeriodEnd:!enabled'), 'Renewal stop/resume can still reconcile without verifying the exact requested final provider state.');
    assert(billingSource.includes('priceId: stripePriceId(subscription)'), 'Stripe provider sync cannot verify the recurring Price actually attached to the subscription.');
    assert(billingSource.includes('expectedProviderPriceId') && billingSource.includes('Stripe price verification mismatch'), 'Canonical provider sync cannot enforce an expected Stripe Price.');

    const planChange = source('src/payments/customer-plan-change.js');
    assert(planChange.includes("timeout:providerHttp.timeoutMs('stripe')"), 'Stripe plan-change calls must use the canonical provider HTTP deadline.');
    const immediate = section(planChange, 'async function setStripePlan', 'async function createLocalChange');
    assert(immediate.includes('let providerMutationAttempted=false'), 'Immediate Stripe plan changes must track whether a remote mutation may have happened.');
    assert(immediate.includes('providerMutationAttempted=true;const updated=await client.subscriptions.update'), 'Immediate Stripe mutation ambiguity is not marked before the provider call.');
    assert(immediate.includes('billingControl.syncSubscription(subscriptionId,{expectedProviderPriceId:mapping.external_id})'), 'Immediate Stripe plan change can still reconcile after merely proving the subscription is readable rather than proving the target Price.');
    assert(immediate.includes('error.planChangeRefusal&&!providerMutationAttempted?{terminal:true}:{}'), 'Ambiguous post-provider Stripe plan-change failures are still forced terminal instead of entering recovery.');
    const scheduled = section(planChange, 'async function scheduleStripeProvider', 'async function requestChange');
    assert(scheduled.includes('let providerMutationAttempted=false'), 'Scheduled Stripe plan changes must track possible provider mutation.');
    assert(scheduled.includes('providerMutationAttempted=true;schedule=await client.subscriptionSchedules.create'), 'Stripe schedule creation ambiguity is not routed into provider-operation recovery.');
    assert(scheduled.includes('providerMutationAttempted=true;const updated=await client.subscriptionSchedules.update'), 'Stripe schedule update ambiguity is not routed into provider-operation recovery.');
    assert(scheduled.includes('error.planChangeRefusal&&!providerMutationAttempted?{terminal:true}:{}'), 'Scheduled Stripe post-provider failures are still forced terminal.');
    assert(scheduled.includes("scheduleChangeId!==String(change.id)"), 'A new local plan change can still take over a Stripe schedule owned by an older CAPTAiNFiN change.');
    assert(scheduled.includes('error.planChangeMutationAttempted=providerMutationAttempted'), 'Schedule errors do not carry provider-mutation ambiguity back to the local plan-change owner.');
    const requestChange = section(planChange, 'async function requestChange', 'async function scheduledStripeSubscription');
    assert(requestChange.includes('error.planChangeRefusal&&!error.planChangeMutationAttempted'), 'Ambiguous Stripe scheduling errors can still be collapsed into a permanent local failure.');
    assert(requestChange.includes("state=CASE WHEN $3::boolean THEN 'failed' ELSE state END"), 'Retryable Stripe scheduling errors do not preserve the open local plan-change state.');
    const dueStripe = section(planChange, 'async function applyDueStripe', 'async function expireDuePaypal');
    assert(dueStripe.includes("throw planChangeRefusal('Scheduled Stripe target price is missing."), 'Deterministic scheduled Stripe invariants must be marked for manual failure.');
    assert(dueStripe.includes('if(error.planChangeRefusal){') && dueStripe.includes("SET state='failed',error=$2"), 'Unrecoverable scheduled Stripe divergence must still become a visible failed plan change.');
    assert(dueStripe.includes("UPDATE customer_plan_changes SET error=$2,updated_at=NOW() WHERE id=$1 AND state='pending'"), 'Transient scheduled Stripe failures must remain pending so the next automation cycle can converge them.');
    assert(dueStripe.includes("provider_schedule_state='applied',error=NULL"), 'Successful scheduled Stripe convergence must clear stale retry errors.');
    assert(dueStripe.includes('provider_schedule_id=COALESCE(provider_schedule_id,$2),provider_schedule_state=$3,error=NULL'), 'A healthy provider schedule observation must backfill missing local schedule identity and clear a previous transient error.');
    assert(dueStripe.includes('billingControl.providerMissing(error)'), 'A provider-confirmed missing Stripe schedule must not remain waiting forever.');
    assert(dueStripe.includes('scheduleTargetPrice(schedule)'), 'Due Stripe schedule verification must prove the remote target still matches the intended plan price.');
    assert(dueStripe.includes('String(schedule.id)!==String(change.provider_schedule_id)'), 'Due Stripe convergence must refuse a different remote schedule from the locally recorded one.');
    const dueVerification = dueStripe.indexOf('billingControl.syncSubscription(current.subscription_id,{expectedProviderPriceId:targetPrice})');
    const dueApplied = dueStripe.indexOf("SET state='applied',provider_schedule_state='applied'");
    assert(dueVerification >= 0 && dueApplied >= 0 && dueVerification < dueApplied, 'Scheduled Stripe convergence can still mark the local plan change applied before exact provider Price verification succeeds.');

    const recoverySource = source('src/payments/provider-operation-recovery.js');
    const recoverImmediate = section(recoverySource, 'async function recoverImmediate', 'async function matchingSchedule');
    assert(recoverImmediate.includes('billingControl.syncSubscription(subscription.id, { expectedProviderPriceId:request.targetPriceId })'), 'Recovered immediate Stripe plan changes can still reconcile without exact target-Price verification.');

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