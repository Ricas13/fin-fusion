'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');
const pricing=read('src/payments/plan-pricing.js');
const providerPricing=read('src/payments/provider-plan-pricing.js');
const discounts=read('src/payments/discounts.js');
const reporting=read('src/platform/reporting-currency.js');
const storefront=read('src/platform/storefront.js');
const publicPages=read('src/platform/public-pages.js');
const publicShellSource=read('src/platform/public-shell.js');
const checkout=read('src/platform/flexible-checkout.js');
const currencySettings=read('src/platform/admin-currency-settings.js');
const planCreate=read('src/platform/admin-plan-create-v2.js');
const adminProfile=read('src/platform/admin-profile-account.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const onboarding=read('views/customer/onboarding.ejs');
const publicShell=require('../src/platform/public-shell');

assert(pricing.includes('const wanted=await platformDefaultCurrency()'),'Plan decoration must resolve the platform master currency');
assert(pricing.includes('async function enabledCurrencies(){return[await platformDefaultCurrency()];}'),'Public currency discovery must expose exactly the master currency');
assert(providerPricing.includes('const c=await pricing.platformDefaultCurrency()'),'Provider checkout mapping must resolve the master currency server-side');
assert(reporting.includes('https://api.frankfurter.dev/v2/rates?base=GBP&quotes=USD,EUR'),'FX refresh must use Frankfurter current public v2 endpoint');
assert(!reporting.includes('api.frankfurter.app'),'FX refresh must not use Frankfurter retired redirecting .app endpoint');
assert(reporting.includes('Array.isArray(body)')&&reporting.includes('row?.quote')&&reporting.includes('row?.rate'),'FX refresh must parse Frankfurter v2 flat rate rows');
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
assert(checkout.includes('currency:choice.currency'),'Discount reservation must use the immutable resolved checkout currency');
assert(discounts.includes('DISCOUNT_CURRENCY_MISMATCH')&&discounts.includes('assertDiscountCurrency'),'Fixed-value discounts must reject a different plan currency before settlement');
assert(customerDashboard.includes('customerId,currency:plan.currency'),'Customer promo preview must validate fixed discounts against each displayed plan currency');
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
assert(onboarding.includes('All paid prices use <strong><%='),'Customer onboarding must present the single portal currency explicitly');

assert(storefront.includes('publicShell.publicHeader({site,nav,logged,registrationOpen})'),'Storefront must render the shared public header');
assert(storefront.includes('publicShell.publicFooter({site,support:shellSupport,registrationOpen})'),'Storefront must render the shared public footer');
assert(publicPages.includes('publicShell.publicHeader({site,nav,active,logged,registrationOpen})'),'Information pages must render the same shared public header');
assert(publicPages.includes('publicShell.publicFooter({site,support,registrationOpen})'),'Information pages must render the shared public footer');
assert(!publicPages.includes('<header class="storeHeader">'),'Information pages must not maintain a separate public header implementation');
assert(!publicPages.includes('<footer class="storeFooter">'),'Information pages must not maintain a separate public footer implementation');
assert(publicShellSource.includes("['trust','Trust','/trust']"),'Trust must be part of the permanent public navigation');

const nav=publicShell.navFromPlans([
  {service_type:'jellyfin',is_free_tier:true},
  {service_type:'jellyfin',is_free_tier:false},
  {service_type:'stremio',is_free_tier:false}
]);
assert.deepStrictEqual(nav,{free:true,plans:true,stremio:true,emby:false},'Shared public shell must discover present storefront sections and keep absent Emby hidden');
const header=publicShell.publicHeader({site:'CAPTAiNFiN',nav,active:'faq',registrationOpen:true});
const permanent=['Free','Plans','Stremio','About','FAQ','Contact','Trust'];
let previous=-1;
for(const label of permanent){const index=header.indexOf(`>${label}</a>`);assert(index>previous,`Public header is missing or reorders ${label}`);previous=index;}
assert(!header.includes('>Emby Shares</a>'),'Emby navigation must stay hidden when no Emby plan exists');
assert(header.includes('href="/#free-access"')&&header.includes('href="/#plans"')&&header.includes('href="/#stremio"'),'Section links must work from both the homepage and information pages');
assert(header.includes('aria-current="page" href="/faq">FAQ</a>'),'Only the current information destination should receive page-current state');
assert(header.includes('>Sign in</a>')&&header.includes('>Get started</a>'),'Public header actions must remain consistent on information pages');
const embyNav=publicShell.navFromPlans([{service_type:'emby',is_free_tier:false}]);
assert.deepStrictEqual(embyNav,{free:false,plans:false,stremio:false,emby:true},'Emby navigation must appear automatically when an Emby plan exists');
const embyHeader=publicShell.publicHeader({site:'CAPTAiNFiN',nav:embyNav,registrationOpen:true});
assert(embyHeader.includes('href="/#emby">Emby Shares</a>'),'Emby plan presence must expose the Emby Shares section link');
const footer=publicShell.publicFooter({site:'CAPTAiNFiN',registrationOpen:true});
assert(footer.includes('Customer sign in')&&footer.includes('Create account')&&footer.includes('FAQ')&&footer.includes('Contact')&&footer.includes('Trust & security'),'Shared public footer must keep account and help destinations together');

console.log('storefront currency integrity smoke: master-currency architecture, shared public shell and UI surfaces ok');