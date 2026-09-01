'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const variantCapacity=require('../src/payments/access-variant-capacity');
const planChange=require('../src/payments/customer-plan-change');

const root=path.resolve(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

const dashboardRoute=read('src/platform/customer-dashboard.js');
const checkoutRoute=read('src/platform/flexible-checkout.js');
const checkoutClient=read('public/js/customer-checkout.js');
const onboardingSelector=read('public/js/customer-stream-selector.js');
const variantsSource=read('src/payments/stream-variants.js');
const planChangeSource=read('src/payments/customer-plan-change.js');
const migration=read('db/migrations/20260901170000_plan_change_access_variants.sql');

assert(dashboardRoute.includes("r.get('/account/plan-variants',requireCustomer"),'active-customer portal must expose a signed-in variant-state endpoint');
assert(dashboardRoute.includes('sellablePlans(Array.from(livePlanIds(portalRaw)))'),'active customers must keep their current plan visible even when its acquisition family is currently full');
assert(dashboardRoute.includes('replacementFits=Boolean(samePlan&&currentQuantity&&quantity<=currentQuantity)'),'same-plan reductions must not be marked sold out just because the shared fleet is full');
assert(dashboardRoute.includes("replacementFits&&variant.capacity?.soldOut?'Available as a reduction'"),'variant state must explain that a capacity-neutral reduction remains available');
assert(dashboardRoute.includes("res.setHeader('Cache-Control','no-store, private, max-age=0')"),'customer-specific variant state must not be cached publicly');

assert(checkoutClient.includes("fetch('/account/plan-variants'"),'dashboard must load the canonical server-owned variant state');
assert(checkoutClient.includes('name=\"accessQuantity\"'),'variant checkout forms must submit the selected access quantity');
assert(checkoutClient.includes('Current access allowance'),'the current stream/household allowance must render as a no-op rather than start checkout');
assert(checkoutClient.includes("if(plan.currentProvider){"),'existing recurring customers must keep plan changes on their current recurring provider');
assert(checkoutClient.includes("modes.includes('subscription')"),'recurring variant changes must require a recurring provider mapping');
assert(checkoutClient.includes('card.dataset.planBaseMinor=String(variant.priceMinor)'),'promo preview must use the selected variant price rather than the logical plan base price');

assert(onboardingSelector.includes('selectInitialAvailable()'),'onboarding must move away from a sold-out default variant when another allowance is purchasable');
assert(onboardingSelector.includes("current.dataset.sold!=='1'&&paymentSet(current).size"),'onboarding must only keep a selected variant when it is both available and payable');
assert(variantsSource.includes("service==='jellyfin'||service==='bundle'"),'Jellyfin bundle plans must share stream-variant semantics');

assert(checkoutRoute.includes('targetAccessQuantity:choice.accessQuantity'),'checkout routing must pass the selected allowance into recurring plan-change handling');
assert(checkoutRoute.includes('targetVariantKind:choice.accessVariantKind'),'checkout routing must preserve whether the selected allowance is streams or households');
assert(checkoutRoute.includes('existingRecurringReplacementOption'),'checkout resolution must have an explicit existing-subscription fallback before reporting a capacity-filtered mapping as unavailable');
assert(checkoutRoute.includes("requestedMode!=='subscription'||!['stripe','paypal'].includes(provider)"),'capacity bypass must be restricted to recurring Stripe/PayPal replacement requests');
assert(checkoutRoute.includes("String(current.plan_id)!==String(target.id)"),'pre-checkout capacity bypass must be restricted to the same logical plan');
assert(checkoutRoute.includes('requestedQuantity<=currentQuantity?mapping:null'),'pre-checkout capacity bypass must allow only capacity-neutral reductions/equal allowances, never upgrades');
assert(checkoutRoute.includes('That is already your current plan, currency and access allowance.'),'same-plan same-allowance requests must return a safe customer-facing no-op error');
assert(planChangeSource.includes('if(samePlan&&requested<=currentQuantity)return uncheckedRecurringMapping'),'same-plan reductions must bypass new-acquisition capacity rejection while upgrades still use authoritative capacity checks');
assert(planChangeSource.includes('target_access_quantity')&&planChangeSource.includes('target_variant_kind'),'scheduled recurring changes must durably persist the selected allowance');
assert(planChangeSource.includes('mappingQuantity(target,mapping)!==Number(change.target_access_quantity)'),'scheduled Stripe reconciliation must reject provider mappings that drift from the selected allowance');

assert(migration.includes('ADD COLUMN IF NOT EXISTS target_access_quantity integer'),'migration must persist target access quantity');
assert(migration.includes('ADD COLUMN IF NOT EXISTS target_variant_kind text'),'migration must persist target variant kind');
assert(migration.includes("target_variant_kind IN ('streams','households')"),'database must constrain persisted variant kinds');
assert(migration.includes('target_access_quantity > 0'),'database must reject non-positive target allowances');

const plan={id:'plan-1',service_type:'jellyfin',streams:3,capacity_limit:null};
const smaller={variant_kind:'streams',access_quantity:1,quantity:1,price_minor:500,currency:'GBP',capacity:{soldOut:false,remaining:2,label:'🔥 Only 2 Premium places left',kind:'urgent'}};
const base={variant_kind:'streams',access_quantity:3,quantity:3,price_minor:900,currency:'GBP',capacity:{soldOut:true,remaining:0,label:'Currently full',kind:'sold'}};
const family=variantCapacity.familyCapacity(plan,base.capacity,[smaller,base]);
assert.strictEqual(family.soldOut,false,'plan family must remain sellable while any access variant has capacity');
assert.strictEqual(family.familyVariantQuantity,1,'family must point customers at an available allowance when the default is full');
assert.strictEqual(variantCapacity.preferredVariant(plan,[smaller,base]),smaller,'preferred variant must fall back to the first available allowance when the base is full');

const baseAvailable={...base,capacity:{soldOut:false,remaining:1,label:'🔥 Only 1 Premium place left',kind:'urgent'}};
assert.strictEqual(variantCapacity.preferredVariant(plan,[smaller,baseAvailable]),baseAvailable,'base allowance should remain preferred when it is available');

const mapping={variant_kind:'streams',access_quantity:2,quantity:2,price_minor:700,currency:'GBP',plan_price_id:'price-row',access_variant_id:'variant-2',provider_mapping_id:'mapping-2',external_id:'price_provider_2',checkout_mode:'subscription'};
const logical={id:'plan-1',code:'premium-monthly',name:'Premium',service_type:'jellyfin',streams:3,billing_interval:'month',duration_days:30,server_class:'premium'};
const selected=planChange.selectedTarget(logical,mapping,'streams',2);
assert.strictEqual(selected.access_quantity,2,'selected target must carry the chosen stream allowance');
assert.strictEqual(selected.streams,2,'selected target stream entitlement must match the chosen allowance');
assert.strictEqual(selected.price_minor,700,'selected target commercial value must use the variant price');

const snapshot=planChange.contractSnapshot(selected,mapping,'stripe');
assert.strictEqual(snapshot.accessQuantity,2,'commercial snapshot must persist selected access quantity');
assert.strictEqual(snapshot.accessVariantKind,'streams','commercial snapshot must persist selected variant kind');
assert.strictEqual(snapshot.streams,2,'commercial snapshot must persist selected Jellyfin stream allowance');
assert.strictEqual(snapshot.accessVariantId,'variant-2','commercial snapshot must retain selected variant identity');
assert.strictEqual(planChange.subscriptionAccessQuantity({commercial_snapshot:{accessQuantity:2,streams:2}},'streams'),2,'current allowance must prefer the immutable commercial snapshot');
assert.strictEqual(planChange.subscriptionAccessQuantity({commercial_snapshot:{stremioHouseholdNetworkLimit:3}},'households'),3,'household allowance must be recovered from the commercial snapshot');

console.log('Customer access variant smoke passed.');
