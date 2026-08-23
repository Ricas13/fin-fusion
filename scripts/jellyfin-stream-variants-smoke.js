'use strict';

const fs=require('fs');
const assert=require('assert');
const read=file=>fs.readFileSync(file,'utf8');

const migration=read('db/migrations/033_jellyfin_stream_variants.sql');
const variants=read('src/payments/stream-variants.js');
const provider=read('src/payments/provider-plan-pricing.js');
const checkout=read('src/platform/flexible-checkout.js');
const dashboard=read('src/platform/customer-dashboard.js');
const onboarding=read('views/customer/onboarding.ejs');
const choice=read('views/customer/payment-choice.ejs');
const admin=read('src/platform/admin-plan-stream-variants.js');
const pricingAdmin=read('src/platform/admin-plan-payment-options.js');
const routes=read('src/platform/admin-route-composition.js');

assert(migration.includes('CREATE TABLE IF NOT EXISTS plan_stream_variants')&&migration.includes('UNIQUE(plan_id, streams, currency)'),'stream variants must be immutable logical plan/currency/stream price rows');
assert(migration.includes('plan_stream_variant_provider_prices')&&migration.includes("provider IN ('stripe','paypal')"),'stream variants must keep dedicated provider mappings instead of add-on quantities');
assert(variants.includes('stream_variants:variants')&&variants.includes('stream_variant_id'),'customer catalogue must expose hidden commercial variants without duplicating logical plans');
assert(provider.includes('streamVariants.resolve')&&provider.includes('capacity.usage(rows[0].id,undefined,{streams:required})'),'provider resolution and scarcity must use the selected stream count');
assert(checkout.includes('streamVariantId:p.stream_variant_id||null')&&checkout.includes('streams:Number(p.streams||choice.streams||1)'),'checkout must snapshot selected stream variant and entitlement');
assert(checkout.includes('targetStreams:choice.streams'),'future/current subscription plan-change flow must receive the selected stream count');
assert(dashboard.includes('streamVariants.decoratePlans')&&dashboard.includes('{streams:Number(variant.streams||plan.streams||1)}'),'Available Access must calculate real capacity for each stream choice');
assert(onboarding.includes('data-stream-selector')&&onboarding.includes('How many simultaneous streams?')&&onboarding.includes('input type="hidden" name="streams"'),'paid plan cards must remain one plan while submitting the selected stream quantity');
assert(onboarding.includes('data-payment-key')&&onboarding.includes('data-sold'),'stream choices must hide unavailable provider modes and respect real capacity');
assert(choice.includes('name="streams" value="<%= streams %>"'),'payment-mode interstitial must preserve the selected stream variant');
assert(admin.includes('Configure up to three higher stream limits')&&admin.includes('Verify & save stream choices'),'admin must control hidden stream variants without creating duplicate catalogue plans');
assert(pricingAdmin.includes('Configure stream choices')&&pricingAdmin.includes('streamVariantAdmin.summary'),'Pricing must expose stream-choice configuration in the normal plan workflow');
assert(routes.includes('createAdminPlanStreamVariantsRouter()'),'stream variant admin routes must be mounted');

console.log('jellyfin stream variants smoke: OK');
