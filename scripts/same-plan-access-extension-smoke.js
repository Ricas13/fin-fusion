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

assert(dashboard.includes('extensionSubscriptionId'),'current-plan UI must identify the exact subscription being extended');
assert(dashboard.includes('name="checkoutMode" value="payment"'),'extensions must always use one-time checkout');
assert(dashboard.includes('Buy more time without losing what remains'),'customer UI must explain additive extension semantics');
assert(checkout.includes("kind:choice.extensionSubscriptionId?'subscription_extension':'direct_plan'"),'checkout contract must identify extension purchases durably');
assert(checkout.includes('validateExtensionChoice'),'checkout must revalidate current-plan ownership server-side');
assert(checkout.includes("checkout_mode:'payment'"),'recurring provider pricing must be convertible to a one-off extension charge');
assert(intents.includes("snapshot.kind !== 'subscription_extension'"),'extensions must not reserve another plan/server capacity slot');
assert(intents.includes("['direct_plan','subscription_extension'].includes(snapshot.kind)"),'provider return verification must accept the extension contract explicitly');
assert(lifecycle.includes("contract?.kind === 'subscription_extension'"),'payment activation must route extension purchases away from new subscription creation');
assert(lifecycle.includes('accessExtensions.applyPurchase'),'extension activation must use the dedicated idempotent lifecycle');
assert(incidents.includes('accessExtensions.revokeByProviderPayment'),'confirmed money loss must remove only the purchased extension');
assert(incidents.includes('accessExtensions.restoreActivePurchasedDays'),'an unrelated base-term reversal must preserve independently paid extension time');
assert(extension.includes('service_extension_days=COALESCE(service_extension_days,0)+$2'),'extension must add paid time to the existing entitlement');
assert(extension.includes('service_extension_days=GREATEST(0,COALESCE(service_extension_days,0)-$2)'),'reversal must remove only its own extension time');
assert(zeroValue.includes("snapshot.kind==='subscription_extension'"),'fully discounted extensions must use the extension lifecycle rather than creating another subscription');
assert(migration.includes('UNIQUE(provider,provider_payment_id)'),'provider payment replay must be database-idempotent');
assert(migration.includes('UNIQUE(checkout_intent_id)'),'checkout replay must be database-idempotent');

console.log('same-plan access extension smoke: ok');
