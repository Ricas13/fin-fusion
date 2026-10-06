'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
function read(file){return fs.readFileSync(path.join(__dirname,'..',file),'utf8');}

const dashboard=read('views/customer/dashboard.ejs');
const checkout=read('src/platform/flexible-checkout.js');
const intents=read('src/payments/checkout-intents.js');
const lifecycle=read('src/payments/lifecycle-primitives.js');
const incidents=read('src/payments/incidents.js');
const zeroValue=read('src/payments/zero-value-checkout.js');
const extension=read('src/payments/subscription-access-extensions.js');
const migration=read('db/migrations/20261005151000_same_plan_access_extensions.sql');
const compatibility=read('src/db-compatibility-migrations.js');
const migrateDb=read('scripts/migrate-db.js');
const health=read('src/platform/health.js');
const paypal=read('src/payments/paypal.js');
const paymentReconciliation=read('src/payments/provider-payment-reconciliation.js');
const checkoutRecovery=read('src/payments/provider-checkout-recovery.js');
const planCapacity=read('src/entitlements/plan-capacity.js');
const productionReadiness=read('scripts/production-readiness.js');

assert(dashboard.includes('extensionSubscriptionId'),'current-plan UI must identify the exact subscription being extended');
assert(dashboard.includes('name="checkoutMode" value="payment"'),'extensions must always use one-time checkout');
assert(dashboard.includes('Buy more time without losing what remains'),'customer UI must explain additive extension semantics');
assert(checkout.includes("kind:choice.extensionSubscriptionId?'subscription_extension':'direct_plan'"),'checkout contract must identify extension purchases durably');
assert(checkout.includes('validateExtensionChoice'),'checkout must revalidate current-plan ownership server-side');
assert(intents.includes("snapshot.kind === 'subscription_extension'")&&intents.includes("pc.state IN('pending','awaiting_checkout')")&&intents.includes("po.operation_type='plan_change_immediate'"),'extension checkout creation must refuse both scheduled and in-flight immediate plan changes before provider money is taken');
assert(require('fs').readFileSync(require('path').join(__dirname,'..','src/payments/customer-plan-change.js'),'utf8').includes('assertNoOutstandingExtensionCheckout'),'plan changes must refuse an open or paid-but-unfulfilled extension checkout before mutating provider billing');
assert(checkout.includes('A plan change is already open for this subscription. Complete or resolve it before buying extra time.'),'commercial-operation conflicts must be safe customer-visible checkout errors');
assert(checkout.includes('public.subscription_access_blocked')&&checkout.includes('Resolve the current account or payment hold before buying extra time.'),'extension checkout must reject held access before the customer is sent to a payment provider');
assert(checkout.includes("choice.extensionSubscriptionId&&String(req.body.discountCode||'').trim()"),'extensions must reject promo codes before discount reservation because redemption identity belongs to the base subscription');
assert(checkout.indexOf("choice.extensionSubscriptionId&&String(req.body.discountCode||'').trim()") < checkout.indexOf('discounts.reserveForIntent'),'promo-code rejection must run before creating any extension discount reservation');
assert(checkout.includes("checkout_mode:'payment'"),'recurring provider pricing must be convertible to a one-off extension charge');
assert(intents.includes("snapshot.kind !== 'subscription_extension'"),'extensions must not reserve another plan/server capacity slot');
assert(intents.includes("['direct_plan','subscription_extension'].includes(snapshot.kind)"),'provider return verification must accept the extension contract explicitly');
assert(lifecycle.includes("['direct_plan','subscription_extension'].includes(snapshot.kind)"),'lifecycle snapshot validation must accept paid extension contracts before extension routing');
assert(lifecycle.includes("contract?.kind === 'subscription_extension'"),'payment activation must route extension purchases away from new subscription creation');
assert(lifecycle.includes('accessExtensions.applyPurchase'),'extension activation must use the dedicated idempotent lifecycle');
assert(lifecycle.includes("contract?.kind === 'subscription_extension'")&&lifecycle.includes('extensionFulfillmentFailure'),'every provider-paid extension fulfillment failure must be durably classified for recovery');
assert(lifecycle.includes('extension_allowance_changed_after_provider_settlement')&&lifecycle.includes('extension_plan_change_open_after_provider_settlement'),'paid extension incidents must preserve actionable failure reasons instead of collapsing to capacity');
assert(extension.includes('ACCESS_EXTENSION_PAYMENT_ALREADY_USED'),'extension lifecycle must reject provider payments already used by normal subscriptions');
assert(lifecycle.includes('PROVIDER_PAYMENT_ALREADY_USED_FOR_EXTENSION'),'normal subscription activation must reject provider payments already consumed by extensions');
assert(extension.includes('billingPeriods.addPlanDuration'),'extension duration must use canonical calendar billing periods');
assert(lifecycle.includes('recomputeActivePurchasedDaysTx'),'provider term updates must rebase calendar extension time');
assert(incidents.includes('accessExtensions.revokeByProviderPayment'),'confirmed money loss must remove only the purchased extension');
assert(incidents.includes('accessExtensions.restoreActivePurchasedDays'),'an unrelated base-term reversal must preserve independently paid extension time');
assert(incidents.includes('extensionPaymentLoss'),'payment incidents must identify extension-only money loss separately from the base subscription');
assert(paymentReconciliation.includes('FROM subscription_access_extensions WHERE provider=$1'),'provider payment reconciliation must load extension purchases as first-class local financial matches');
assert(paymentReconciliation.includes('const purchase = subscription || extension'),'healthy extension payments must not be reported as provider money with no local purchase');
assert(paymentReconciliation.includes("FROM subscription_access_extensions")&&paymentReconciliation.includes("TRUE AS is_extension"),'PayPal capture reconciliation must include extension-ledger ownership');
assert(paymentReconciliation.includes('!subscription && !extension && checkout'),'PayPal reconciliation must not mark a captured extension as fulfillment-pending once its extension ledger exists');
assert(checkoutRecovery.includes('FROM subscription_access_extensions sae')&&checkoutRecovery.includes('sae.checkout_intent_id=i.id'),'completed PayPal extension checkouts must leave automated recovery once the extension ledger owns the capture');
assert(paypal.includes('incidentResult?.extensionPaymentLoss')&&read('src/payments/stripe.js').includes('incidentResult?.extensionPaymentLoss'),'extension refunds/chargebacks must not reverse affiliate rewards earned by the base subscription');
assert(extension.includes('service_extension_days=COALESCE(service_extension_days,0)+$2'),'extension must add paid time to the existing entitlement');
assert(extension.includes("SET status='revoked'")&&extension.includes('recomputeActivePurchasedDaysTx(client,extension.subscription_id,extension.customer_id)'),'reversal must revoke the exact purchase and recompute remaining calendar-aware extension time instead of subtracting stale historical days');
assert(zeroValue.includes("snapshot.kind==='subscription_extension'"),'fully discounted extensions must use the extension lifecycle rather than creating another subscription');
assert(migration.includes('UNIQUE(provider,provider_payment_id)'),'provider payment replay must be database-idempotent');
assert(migration.includes('UNIQUE(checkout_intent_id)'),'checkout replay must be database-idempotent');
assert(migration.includes('applied_days integer NOT NULL')&&migration.includes('ADD COLUMN IF NOT EXISTS applied_days'),'extension ledger must separate immutable purchase history from current aggregate contribution and remain rolling-compatible');
assert(extension.includes('recordedAppliedDays')&&extension.includes('SET applied_days=$2'),'refund/rebase logic must remove revoked time once without erasing unrelated extension days later');
assert(compatibility.includes("'20261005151000_same_plan_access_extensions.sql'"),'extension schema must be classified as rolling-compatible so N-1 readiness is preserved');
assert(migrateDb.includes('applyRepeatableCompatibilityMigration'),'migration runner must apply extension schema outside the versioned readiness ledger');
assert(health.includes('latestVersionedMigration'),'candidate readiness must ignore repeatable compatibility migrations');
assert(extension.includes('ACCESS_EXTENSION_ALLOWANCE_CHANGED'),'settlement must reject stale cheaper access-allowance contracts');
const paypalOrderStart=paypal.indexOf('async function activateCompletedOrder');
const paypalComplete=paypal.indexOf("await checkoutIntents.completeVerifiedProvider('paypal',order.id,'completed')",paypalOrderStart);
const paypalLedger=paypal.indexOf('await recordCompletedCapture(capture',paypalOrderStart);
const paypalFulfill=paypal.indexOf('const activated=await lifecycle.activatePurchase',paypalOrderStart);
assert(paypalOrderStart>=0&&paypalComplete>paypalOrderStart&&paypalLedger>paypalComplete&&paypalFulfill>paypalLedger,
  'PayPal one-time checkout must complete local provider state, persist verified money, then fulfill access so accounting and paid-but-unfulfilled recovery stay durable');


assert(require('fs').readFileSync(require('path').join(__dirname,'..','src/payments/customer-plan-change.js'),'utf8').includes('This subscription has prepaid extension time remaining.'),'plan changes must not convert prepaid extension time into a different plan/currency/access allowance');
assert(
  (planCapacity.match(/service_extension_days/g)||[]).length>=5
    && planCapacity.includes("cs.current_period_end+((cs.service_extension_days||' days')::interval)>NOW()"),
  'all plan-capacity paths, including legacy catalog admission, must retain extension-backed occupancy after the provider base term ends'
);
assert(
  productionReadiness.includes("current_period_end+((service_extension_days||' days')::interval)>NOW()")
    && productionReadiness.includes("COALESCE(service_extension_days,0)>0"),
  'production readiness must not classify prepaid extension-backed access as stale or unaffected by server loss'
);
console.log('same-plan access extension smoke: ok');
