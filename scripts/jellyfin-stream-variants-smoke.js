'use strict';

const fs=require('fs');
const assert=require('assert');
const read=file=>fs.readFileSync(file,'utf8');

const migration=read('db/migrations/033_jellyfin_stream_variants.sql');
const variants=read('src/payments/stream-variants.js');
const provider=read('src/payments/provider-plan-pricing.js');
const checkout=read('src/platform/flexible-checkout.js');
const intents=read('src/payments/checkout-intents.js');
const capacity=read('src/entitlements/plan-capacity.js');
const dashboard=read('src/platform/customer-dashboard.js');
const onboarding=read('views/customer/onboarding.ejs');
const selector=read('public/js/customer-stream-selector.js');
const choice=read('views/customer/payment-choice.ejs');
const stremioDashboard=read('views/customer/stremio-dashboard.ejs');
const householdAccess=read('src/stremio/household-access.js');
const admin=read('src/platform/admin-plan-stream-variants.js');
const pricingAdmin=read('src/platform/admin-plan-payment-options.js');
const routes=read('src/platform/admin-route-composition.js');

assert(migration.includes('CREATE TABLE IF NOT EXISTS plan_access_variants')&&migration.includes("variant_kind IN ('streams','households')")&&migration.includes('UNIQUE(plan_id, variant_kind, quantity, currency)'),'access variants must keep immutable logical plan/kind/quantity/currency price rows');
assert(migration.includes('plan_access_variant_provider_prices')&&migration.includes("provider IN ('stripe','paypal')"),'access variants must keep dedicated provider mappings instead of recurring add-on quantities');
assert(migration.includes("commercial_snapshot->>'stremioHouseholdNetworkLimit'")&&migration.includes('UPDATE OF plan_id,commercial_snapshot'),'Stremio household quantity must be frozen from the commercial contract on subscription activation');
assert(variants.includes("if(service==='stremio')return'households'")&&variants.includes("return{...plan,access_variant_kind:kind,access_variants:variants"),'customer catalogue must expose hidden stream or household variants without duplicating logical plans');
assert(variants.includes("p.service_type='stremio' AND v.variant_kind='households'")&&variants.includes("p.service_type IN('jellyfin','bundle') AND v.variant_kind='streams'"),'provider variant resolution must bind each service to the correct quantity type');
assert(provider.includes("kind==='households'?{households:required}:{streams:required}")&&provider.includes('accessVariants.resolve'),'provider resolution and scarcity must use the selected stream or household quantity');
assert(checkout.includes('accessVariantId:p.access_variant_id||null')&&checkout.includes('accessVariantKind:variantKind')&&checkout.includes('stremioHouseholdNetworkLimit:Number(p.stremio_household_network_limit||1)'),'checkout must snapshot the selected access variant and Stremio household entitlement');
assert(intents.includes('households:snapshot.stremioHouseholdNetworkLimit'),'open checkout intents must reserve the selected Stremio household quantity atomically');
assert(capacity.includes('async function stremioHouseholdUsage')&&capacity.includes("commercial_snapshot->'stremioHouseholdNetworkLimit'")&&capacity.includes('Math.floor(householdRemaining/requiredHouseholds)'),'manual Stremio capacity must be consumed by household units and converted into honest purchasable-place scarcity');
assert(dashboard.includes('accessVariants.decoratePlans')&&dashboard.includes("variant.variant_kind==='households'?{households:quantity}:{streams:quantity}"),'Available Access must calculate real capacity for each stream or household choice');
assert(onboarding.includes('data-access-selector')&&onboarding.includes('How many households?')&&onboarding.includes('How many simultaneous streams?')&&onboarding.includes('input type="hidden" name="accessQuantity"'),'paid plan cards must remain one plan while submitting the selected stream or household quantity');
assert(onboarding.includes('data-payment-key')&&onboarding.includes('data-sold'),'access choices must hide unavailable provider modes and respect real capacity');
assert(onboarding.includes('<script src="/js/customer-stream-selector.js" defer></script>')&&!/<script(?![^>]*src=)[^>]*>/i.test(onboarding),'access selector behavior must stay in an external CSP-safe script');
assert(selector.includes("querySelectorAll('[data-access-card]')")&&selector.includes("input[name=\"accessQuantity\"]")&&selector.includes("kind==='households'")&&selector.includes('payments.has(el.dataset.paymentKey)'),'external selector script must synchronize price, entitlement, capacity and provider buttons for both access types');
assert(choice.includes('name="accessQuantity" value="<%= quantity %>"')&&choice.includes("accessVariantKind==='households'"),'payment-mode interstitial must preserve and describe the selected access quantity');
assert(householdAccess.includes('COALESCE(s.stremio_household_network_limit_snapshot,p.stremio_household_network_limit)'),'Stremio runtime must enforce the snapshotted household allowance');
assert(stremioDashboard.includes('currentHouseholds=households(currentPlan)')&&stremioDashboard.includes('Devices & streams inside each household'),'Stremio customer account must show the purchased household allowance');
assert(admin.includes("kind==='households'?'Household choices':'Stream choices'")&&admin.includes("kind==='households'?'household':'stream'"),'admin commercial variants must adapt labels/actions to the product access type');
assert(admin.includes('paid standalone Stremio plans')&&admin.includes('plan_access_variants')&&admin.includes('plan_access_variant_provider_prices'),'admin must configure hidden Stremio household variants using the shared commercial variant tables');
assert(pricingAdmin.includes('accessVariantAdmin.summary')&&pricingAdmin.includes('selected price, currency, access quantity and provider mapping'),'Pricing must expose access-quantity configuration in the normal plan workflow');
assert(routes.includes('createAdminPlanStreamVariantsRouter()'),'access variant admin routes must remain mounted through the existing compatibility route owner');

console.log('Jellyfin stream and Stremio household variants smoke: OK');
