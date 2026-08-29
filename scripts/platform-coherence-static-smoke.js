'use strict';
const assert=require('assert');
const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const app=read('src/application.js');
assert(app.includes("./platform/router"),'application must mount platform router');
assert(!app.includes("./platform/admin-route-shim"),'application must not mount retired admin route shim');

const platform=read('src/platform/router.js');
assert(platform.includes("require('./admin-router')"),'platform router must mount canonical admin router');
assert(platform.includes("require('./customer-router')"),'platform router must mount canonical customer router');

const admin=read('src/platform/admin-router.js');
assert(admin.includes("require('./admin-customers')"),'admin router must own customer admin routes');
assert(admin.includes("require('./admin-plans')"),'admin router must own plan admin routes');
assert(admin.includes("require('./admin-servers')"),'admin router must own server admin routes');
assert(admin.includes("require('./admin-settings')"),'admin router must own settings routes');

const customer=read('src/platform/customer-router.js');
assert(customer.includes("require('./customer-dashboard')"),'customer router must own dashboard routes');
assert(customer.includes("require('./customer-settings')"),'customer router must own settings routes');
assert(customer.includes("require('./customer-subscriptions')"),'customer router must own subscription routes');

const provisioning=read('src/jellyfin/provisioning.js');
assert(provisioning.includes('reconcileCustomer'),'provisioning must expose canonical customer reconciliation');
const resilient=read('src/jellyfin/resilient-provisioning.js');
assert(resilient.includes('provisioning.reconcileCustomer'),'resilient provisioning must wrap the canonical owner');

const holds=read('src/entitlements/access-holds.js');
assert(holds.includes('customer_access_holds'),'access holds must persist in PostgreSQL');
assert(holds.includes('reconcileCustomer'),'access-hold changes must reconcile provisioning');

const entitlements=read('src/entitlements/effective.js');
assert(entitlements.includes('effective_customer_entitlements'),'effective entitlement owner must use the canonical view');

const settings=read('src/platform/settings.js');
assert(settings.includes('platform_settings'),'platform settings must use PostgreSQL');
const branding=read('src/platform/branding.js');
assert(branding.includes('branding_assets'),'branding must use shared PostgreSQL asset storage');
assert(branding.includes('importLegacy'),'existing filesystem branding must have an upgrade-safe import path');

const plans=read('src/platform/admin-plans.js');
assert(plans.includes('Impact preview'),'plan management must expose edit impact before destructive changes');
assert(plans.includes('impactConfirmation'),'impactful plan changes must require explicit confirmation');
assert(!/Authenticator \/ recovery code/i.test(plans),'plan management must not show fake repeated 2FA prompts');

const lifecycle=read('src/payments/lifecycle.js');
for(const policy of ['once_ever','once_per_plan','before_paid','renewable','permanent','downgradeToFree'])assert(lifecycle.includes(policy),`free/trial policy is missing ${policy}`);

const directCheckout=read('src/platform/flexible-checkout.js');
assert(/idempotencyKey\s*:\s*intent\.id/.test(directCheckout),'direct checkout must pass the durable local intent ID to payment providers');
assert(directCheckout.includes('applyServiceCredit'),'direct checkout must support service-credit reservation before provider redirect');
const checkoutIntents=read('src/payments/checkout-intents.js');
assert(checkoutIntents.includes('serviceCreditReservations.settle'),'checkout completion must settle reserved service credit atomically');
const creditReservations=read('src/payments/service-credit-reservations.js');
const creditAccounting=read('src/payments/service-credit-accounting.js');
assert(creditReservations.includes('reserveForIntent')&&creditAccounting.includes("state='reserved'"),'service-credit checkout reservations must protect against double spend through the canonical accounting owner');
assert(creditReservations.includes('accounting.ensureHistoricalAllocations')&&creditAccounting.includes('allocateOneDebit'),'service-credit mutations must allocate debit provenance through the canonical accounting owner');

const stripeBilling=read('src/payments/stripe.js');
assert(stripeBilling.includes('internal_checkout_intent_id'),'Stripe checkout must preserve the local intent ID in provider metadata');
assert(/checkout\.sessions\.create\(params,\s*\{\s*idempotencyKey/.test(stripeBilling),'Stripe checkout must use a provider idempotency key');
const paypalBilling=read('src/payments/paypal.js');
assert(/providerRequestId\s*=\s*idempotencyKey/.test(paypalBilling),'PayPal checkout must derive PayPal-Request-Id from the local checkout intent');
assert(paypalBilling.includes('Service credit cannot be combined with a recurring PayPal subscription'),'PayPal must fail closed for unsafe recurring mixed-credit checkout');

const customerPlanChange=read('src/payments/customer-plan-change.js');
assert(!/effective_at<=NOW\(\)\+INTERVAL\s*'15 minutes'/.test(customerPlanChange),'scheduled customer plan changes must not alter entitlements before the paid-through boundary');
assert(customerPlanChange.includes('effective_at<=NOW()'),'scheduled Stripe plan changes must become due only at the paid-through boundary');
assert(customerPlanChange.includes('scheduledStripeSubscription'),'due plan changes must resolve their recorded subscription even immediately after its previous period ends');

console.log('platform coherence static smoke: ok');