'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const pricing=read('src/payments/plan-pricing.js');
const providerPricing=read('src/payments/provider-plan-pricing.js');
const reporting=read('src/platform/reporting-currency.js');
const storefront=read('src/platform/storefront.js');
const checkout=read('src/platform/flexible-checkout.js');
const currencySettings=read('src/platform/admin-currency-settings.js');
const planCreate=read('src/platform/admin-plan-create-v2.js');
const adminProfile=read('src/platform/admin-profile-account.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const onboarding=read('views/customer/onboarding.ejs');

assert(pricing.includes('const wanted=await platformDefaultCurrency()'),'Plan decoration must resolve the platform master currency');
assert(pricing.includes('async function enabledCurrencies(){return[await platformDefaultCurrency()];}'),'Public currency discovery must expose exactly the master currency');
assert(providerPricing.includes('const c=await pricing.platformDefaultCurrency()'),'Provider checkout mapping must resolve the master currency server-side');
assert(reporting.includes("'admin.portal_currency.update'"),'Master currency changes must be audited');
assert(reporting.includes("pricingMode:'same_numeric_amount'"),'Currency switching must explicitly preserve numeric catalogue amounts');
assert(reporting.includes('active=CASE WHEN p.is_free_tier THEN TRUE ELSE FALSE END'),'Paid legacy currency rows must retire while canonical free-tier rows stay active');
assert(reporting.includes('pr.currency<>$2'),'Provider mappings for non-master catalogue currencies must retire from new sales');
assert(reporting.includes('plan.is_free_tier?0:Number(plan.price_minor||0)'),'Currency reconciliation must keep the canonical free tier at zero');
assert(reporting.includes("verification_status='unverified'"),'Changed target-currency mappings must be invalidated for re-verification');
assert(reporting.includes('async function getForUser(_userId)'),'Per-admin reporting currency must no longer override the portal currency');
assert(storefront.includes('async function selectedCurrency(_req){return planPricing.platformDefaultCurrency();}'),'Storefront must ignore query/session currency overrides');
assert(storefront.includes('function currencySwitcher(_currency,_currencies){return\'\';}'),'Storefront must not expose a customer currency switcher');
assert(checkout.includes('async function requestedCurrency(_req){return planPricing.platformDefaultCurrency();}'),'Checkout must ignore client/session currency overrides');
assert(currencySettings.includes('changes the denomination of the current catalogue'),'Admin currency UI must explain switch semantics');

assert(/const\s+reportingCurrency\s*=\s*require\(['"]\.\/reporting-currency['"]\)/.test(planCreate),'Plan creation must load the portal currency server-side');
assert(/currency\s*=\s*\(await\s+reportingCurrency\.get\(\)\)\.currency/.test(planCreate)&&/parse\(req\.body,\s*currency\)/.test(planCreate),'Plan creation must override any posted currency with the master currency');
assert(/await\s+planPricing\.setPrice\(client,\s*result\.rows\[0\]\.id,/.test(planCreate),'New plans must create their active master-currency price row');
assert(!planCreate.includes('<select class="input" name="currency">'),'Plan creation must not expose a per-plan currency selector');
assert(planCreate.includes('not configurable per plan'),'Plan creation must explain that currency is portal-wide');

assert(!adminProfile.includes("require('./reporting-currency')"),'Admin profile must not own reporting currency anymore');
assert(!adminProfile.includes('/admin/profile/currency'),'Admin profile must not expose a personal currency mutation route');
assert(!adminProfile.includes('Reporting currency'),'Admin profile must not expose a personal reporting currency control');
assert(!customerDashboard.includes('storefrontCurrency'),'Customer account must not resolve currency from session state');
assert(!customerDashboard.includes('userPreferredCurrency'),'Customer account must not resolve a per-user currency preference');
assert(!customerDashboard.includes('enabledCurrencies()'),'Customer account must not request a list of customer-selectable currencies');
assert(!onboarding.includes('name="currency"'),'Customer checkout forms must not post a customer-selected currency');
assert(onboarding.includes('All paid prices are in <strong><%= currency %></strong>'),'Customer onboarding must present the single portal currency explicitly');

console.log('storefront currency integrity smoke: master-currency architecture and UI surfaces ok');