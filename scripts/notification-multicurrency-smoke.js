'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const migration=read('db/migrations/077_notifications_multicurrency_reporting.sql');
const integrity=read('db/migrations/078_multicurrency_contract_integrity.sql');
const transactional=read('db/migrations/079_notification_transactional_scopes.sql');
const pricing=read('src/payments/plan-pricing.js');
const providerPricing=read('src/payments/provider-plan-pricing.js');
const checkout=read('src/platform/flexible-checkout.js');
const intents=read('src/payments/checkout-intents.js');
const stripe=read('src/payments/stripe.js');
const paypal=read('src/payments/paypal.js');
const validator=read('src/payments/provider-mapping-validator.js');
const commerce=read('src/platform/admin-plan-payment-options.js');
const storefront=read('src/platform/storefront.js');
const communications=read('src/platform/customer-communications.js');
const nav=read('src/platform/admin-nav.js');

assert(migration.includes('CREATE TABLE IF NOT EXISTS plan_prices'),'Migration must create per-currency logical-plan prices');
assert(migration.includes('UNIQUE(plan_id,currency)'),'A logical plan may have at most one price per currency');
assert(migration.includes('ADD COLUMN IF NOT EXISTS plan_price_id UUID REFERENCES plan_prices'),'Provider mappings must belong to a price variant');
assert(migration.includes('preferred_currency CHAR(3)'),'Users must have an independent reporting/display currency preference');
assert(migration.includes("preferred_currency IN ('GBP','USD','EUR')"),'Only GBP/USD/EUR are supported');
assert(integrity.includes('FOREIGN KEY(plan_price_id,plan_id) REFERENCES plan_prices(id,plan_id)'),'Provider mapping must not point at another logical plan price');
assert(integrity.includes('snapshot_subscription_multicurrency_contract'),'Subscription rows must persist selected price/provider mapping audit identifiers');
assert(transactional.includes("customer.subscription.requested','both',FALSE"),'Mandatory customer acknowledgement events must stay customer-addressable without becoming optional customer toggles');

assert(pricing.includes("const CURRENCIES=Object.freeze(['GBP','USD','EUR'])"),'Pricing service must explicitly support GBP/USD/EUR');
assert(providerPricing.includes('JOIN plan_prices pr ON pr.plan_id=p.id AND pr.active=TRUE'),'Checkout provider resolution must join an active currency price');
assert(providerPricing.includes('pr.currency=$3'),'Checkout provider resolution must require the selected currency');
assert(checkout.includes('req.session?.storefrontCurrency'),'Checkout must honor the storefront-selected currency');
assert(checkout.includes('planPriceId:p.plan_price_id'),'Commercial snapshots must persist the selected plan price');
assert(checkout.includes('providerMappingRecordId:p.provider_mapping_id'),'Commercial snapshots must persist the selected provider mapping record');
assert(intents.includes('plan_price_id')&&intents.includes('snapshot.planPriceId'),'Checkout intent verification must bind the immutable snapshot to the selected price row');
assert(stripe.includes('resolvedPlan')&&stripe.includes('internal_plan_price_id'),'Stripe checkout must use the already-resolved currency-specific price');
assert(paypal.includes('resolvedPlan')&&paypal.includes('currency_code:String(plan.currency).toUpperCase()'),'PayPal one-time checkout must use the already-resolved selected currency');
assert(validator.includes('JOIN plan_prices pr ON pr.id=pp.plan_price_id'),'Provider mapping verification must validate the exact currency variant amount');
assert(commerce.includes('Multi-currency pricing'),'Plan Commerce must expose price variants under one logical plan');
assert(commerce.includes('Plan price changed; re-verification required.'),'Editing a price must invalidate provider verification');
assert(storefront.includes('currencySwitcher(currency,currencies)'),'Storefront must provide one currency switcher rather than duplicate products');
assert(storefront.includes('planPricing.decoratePlans(logicalPlans,currency)'),'Storefront must decorate logical products with the selected currency price');
assert(communications.includes("customer_opt_in_allowed=TRUE AND event_scope IN ('customer','both')"),'Customer event catalogue must be server-filtered to globally permitted customer events');
assert(nav.includes("['notification-settings','Notifications','/admin/notifications/preferences']"),'Global Notifications must remain under Settings');
assert(nav.includes("['my-notifications','My Notifications','/admin/profile/notifications']"),'Per-admin notification preferences must be discoverable separately');

console.log('notification + multi-currency smoke: ok');
