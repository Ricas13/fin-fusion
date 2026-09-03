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
const storefrontRefinement=read('public/css/storefront-refinement.css');
const storefrontPlanDriven=read('public/css/storefront-plan-driven.css');
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

assert(storefront.includes("const affiliateCredits=require('../affiliate-credits');"),'Storefront affiliate showcase must use the canonical affiliate-credit service');
assert(storefront.includes('async function storefrontAffiliate(customerId,currency)')&&storefront.includes('affiliateCredits.loadSettings()')&&storefront.includes('affiliateCredits.balances(customerId)'),'Storefront must derive affiliate enablement and signed-in balances from the canonical ledger');
assert(storefront.includes("if(!affiliate?.enabled)return'';"),'Disabled affiliate programs must render no storefront affiliate promotion');
assert(storefront.includes("balances.find(row=>String(row.currency||'').toUpperCase()===String(currency||'GBP').toUpperCase())"),'Storefront affiliate balance must follow the master storefront currency');
assert(storefront.includes('paymentMethodsStrip(paymentMethods,affiliate,currency,logged)'),'Affiliate promotion must share the payment-method showcase region');
assert(storefront.includes("logged?'/account/affiliate':'/account/login?next=%2Faccount%2Faffiliate'"),'Affiliate CTA must send signed-in customers to Affiliate and anonymous visitors through sign-in');
assert(storefront.includes('`${money(available,currency)} available credit`')&&storefront.includes('`${money(pending,currency)} pending credit`'),'Signed-in storefront must surface real available and pending affiliate credit');
assert(storefront.includes('function referralArtwork()')&&storefront.includes('class="affiliateArtwork"')&&storefront.includes('<svg viewBox="0 0 260 220"'),'Affiliate feature card must include its own embedded referral artwork without an external image dependency');
assert(storefront.includes('class="paymentMethodsShowcase ${affiliateCard?\'hasAffiliate\':\'paymentsOnly\'}"'),'Payment and affiliate promotion must render as two peer feature cards when Affiliate is enabled');
assert(storefront.includes('class="paymentMethodsCard"')&&storefront.includes('class="affiliatePromoCard"'),'Storefront must keep payment methods and Affiliate in separate large cards');
assert(storefront.includes("const STOREFRONT_ASSET_REV='20260903-1734';"),'Storefront must bump the asset revision when compact banner CSS ships');
assert(storefront.includes('/css/storefront.css?v=${STOREFRONT_ASSET_REV}')&&storefront.includes('/css/storefront-refinement.css?v=${STOREFRONT_ASSET_REV}')&&storefront.includes('/css/storefront-plan-driven.css?v=${STOREFRONT_ASSET_REV}'),'Storefront CSS links must be cache-busted so browsers cannot keep stale banner styling');
assert(storefrontRefinement.includes('.paymentMethodsShowcase{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,.95fr)'),'Desktop storefront must use the intended two-card split layout');
assert(storefrontRefinement.includes('.paymentMethodsList{position:relative;z-index:1;display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'),'Payment method mini-cards must remain a three-column row inside the payment card');
assert(storefrontRefinement.includes('.affiliatePromoCard{display:grid;grid-template-columns:minmax(0,1fr) minmax(125px,.5fr)'),'Affiliate promotion must reserve a compact dedicated visual column for its artwork');
assert(storefrontPlanDriven.includes('.paymentMethodsCard,.affiliatePromoCard{height:140px!important;min-height:140px!important;padding:14px 16px!important}'),'Payment and affiliate feature cards must stay at the requested roughly half-height 140px desktop layout');
assert(storefrontPlanDriven.includes('.paymentMethodsCard{display:grid!important;grid-template-columns:minmax(190px,.9fr) minmax(0,1.55fr)!important;align-items:center!important;gap:14px!important}'),'Payment card content must reorganize horizontally so the 140px layout does not clip');
const visibleFreeBorder='border:1px solid rgba(76,201,240,.22)!important';
const visibleFreeBackground='background:linear-gradient(115deg,rgba(20,40,50,.7),rgba(15,21,28,.98) 58%,rgba(11,16,22,.98))!important';
const visibleFreeShadow='box-shadow:0 24px 80px rgba(0,0,0,.24),inset 0 1px rgba(255,255,255,.035)!important';
assert(storefrontPlanDriven.includes('.freeTierPanel.soldOut{border-color:rgba(76,201,240,.22);background:linear-gradient(115deg,rgba(20,40,50,.7),rgba(15,21,28,.98) 58%,rgba(11,16,22,.98))}'),'Free Server sold-out reference colours must remain stable');
assert(storefrontPlanDriven.includes(visibleFreeBorder)&&storefrontPlanDriven.includes(visibleFreeBackground)&&storefrontPlanDriven.includes(visibleFreeShadow),'Payment and affiliate cards must copy the visible Free Server card border, background and shadow exactly');
assert(storefrontPlanDriven.includes('.paymentMethodsShowcase{gap:14px!important;padding:0!important;border:0!important;border-radius:0!important;background:none!important;box-shadow:none!important;backdrop-filter:none!important}'),'Payment showcase wrapper must not add a second coloured frame or extra height around the two cards');
assert(storefrontPlanDriven.includes('.paymentMethodsCard:before,.affiliatePromoCard:before{content:"";position:absolute;inset:auto;width:320px;height:320px;border-radius:50%;left:-120px;top:-180px;background:radial-gradient(circle,rgba(76,201,240,.18),transparent 68%);pointer-events:none}'),'Top cards must copy the Free Server teal glow treatment exactly');
assert(storefrontPlanDriven.includes('.heroSection{padding:42px 0 18px!important}')&&storefrontPlanDriven.includes('.heroGrid{min-height:440px!important}')&&storefrontPlanDriven.includes('.heroVisual{height:420px!important}'),'Storefront hero must not restore the oversized gap between the top navigation and first heading');
assert(!storefrontRefinement.includes('rgba(95,87,255,.58)'),'Affiliate card must not regress to the purple treatment that clashes with the Free Server banner');
assert(storefrontRefinement.includes('@media(max-width:1050px)')&&storefrontRefinement.includes('.paymentMethodsShowcase{grid-template-columns:1fr}'),'The two-card showcase must stack cleanly on narrower displays');

assert(storefront.includes('publicShell.publicHeader({site,nav,logged,registrationOpen})'),'Storefront must render the shared public header');
assert(storefront.includes('publicShell.publicFooter({site,support:shellSupport,registrationOpen})'),'Storefront must render the shared public footer');
assert(publicPages.includes('publicShell.publicHeader({site,nav,active,logged,registrationOpen})'),'Information pages must render the same shared public header');
assert(publicPages.includes('publicShell.publicFooter({site,support,registrationOpen})'),'Information pages must render the same shared public footer');
assert(!publicPages.includes('<header class="storeHeader">'),'Information pages must not maintain a separate public header implementation');
assert(!publicPages.includes('<footer class="storeFooter">'),'Information pages must not maintain a separate public footer implementation');
for(const [key,label] of [['about','About'],['faq','FAQ'],['help','Help'],['contact','Contact'],['trust','Trust']]){
  assert(!publicShellSource.includes(`['${key}','${label}',`),`${label} must stay out of the public top navigation`);
}

const nav=publicShell.navFromPlans([
  {service_type:'jellyfin',is_free_tier:true},
  {service_type:'jellyfin',is_free_tier:false},
  {service_type:'stremio',is_free_tier:false}
]);
assert.deepStrictEqual(nav,{free:true,plans:true,stremio:true,emby:false},'Shared public shell must discover present storefront sections and keep absent Emby hidden');
const header=publicShell.publicHeader({site:'CAPTAiNFiN',nav,active:'faq',registrationOpen:true});
const permanent=['Free','Plans','Stremio'];
let previous=-1;
for(const label of permanent){const index=header.indexOf(`>${label}</a>`);assert(index>previous,`Public header is missing or reorders ${label}`);previous=index;}
for(const label of ['About','FAQ','Help','Contact','Trust']) assert(!header.includes(`>${label}</a>`),`${label} must stay out of the public top navigation`);
assert(!header.includes('>Emby Shares</a>'),'Emby navigation must stay hidden when no Emby plan exists');
assert(header.includes('href="/#free-access"')&&header.includes('href="/#plans"')&&header.includes('href="/#stremio"'),'Section links must work from both the homepage and information pages');
assert(!header.includes('aria-current="page"'),'Hidden information destinations must not receive page-current state in the public header');
assert(header.includes('>Sign in</a>')&&header.includes('>Get started</a>'),'Public header actions must remain consistent on information pages');
const embyNav=publicShell.navFromPlans([{service_type:'emby',is_free_tier:false}]);
assert.deepStrictEqual(embyNav,{free:false,plans:false,stremio:false,emby:true},'Emby navigation must appear automatically when an Emby plan exists');
const embyHeader=publicShell.publicHeader({site:'CAPTAiNFiN',nav:embyNav,registrationOpen:true});
assert(embyHeader.includes('href="/#emby">Emby Shares</a>'),'Emby plan presence must expose the Emby Shares section link');
const footer=publicShell.publicFooter({site:'CAPTAiNFiN',registrationOpen:true});
assert(footer.includes('Customer sign in')&&footer.includes('Create account')&&footer.includes('FAQ')&&footer.includes('Contact')&&footer.includes('Trust & security'),'Shared public footer must keep account and help destinations together');

console.log('storefront currency integrity smoke: half-height payment and affiliate banners, exact Free Server colours, cache-busted assets, compact hero and shared public shell ok');
