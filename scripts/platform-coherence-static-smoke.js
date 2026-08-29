'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const ROOT=path.resolve(__dirname,'..');
function read(rel){return fs.readFileSync(path.join(ROOT,rel),'utf8');}
function exists(rel){return fs.existsSync(path.join(ROOT,rel));}
function walk(dir,out=[]){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){if(['node_modules','.git'].includes(entry.name))continue;const full=path.join(dir,entry.name);if(entry.isDirectory())walk(full,out);else out.push(full);}return out;}
function rel(file){return path.relative(ROOT,file).replaceAll(path.sep,'/');}

const packageJson=JSON.parse(read('package.json'));
assert.strictEqual(packageJson.scripts.start,'node src/application.js','supported startup must use canonical application composition');
assert.strictEqual(packageJson.scripts['automation:worker'],'node scripts/automation-worker.js');
assert.strictEqual(packageJson.scripts.syntax,'node scripts/check-js-syntax.js');

for(const removed of ['import_users.js','check-expired.js'])assert(!exists(removed),`${removed} must remain removed from the supported tree`);
for(const migration of ['000_database_baseline.sql','001_remove_retired_product.sql'])assert(exists(`db/migrations/${migration}`),`missing baseline migration ${migration}`);

const application=read('src/application.js'),platformRouter=read('src/platform/router.js');
const adminRouteComposition=exists('src/platform/admin-route-composition.js')?read('src/platform/admin-route-composition.js'):application;
const customerRouteComposition=exists('src/platform/customer-route-composition.js')?read('src/platform/customer-route-composition.js'):platformRouter;
assert(adminRouteComposition.includes('createAdminDriftRouter'),'Policy Drift must be mounted by the canonical admin route composition');
assert(customerRouteComposition.includes('createCustomerAffiliateRouter')&&customerRouteComposition.includes('router.use(createCustomerAffiliateRouter())'),'customer affiliate runtime must be mounted by the canonical customer/platform route composition');
assert(adminRouteComposition.includes('createAdminReferralsRouter'),'affiliate administration must be mounted by the canonical admin route composition');

const automation=read('src/automation/jobs.js');
for(const key of ['policy_drift','billing','plan_changes','referral_rewards','activation_cleanup','pending_registration_cleanup'])assert(new RegExp(`\\b${key}\\b`).test(automation),`automation worker is missing ${key}`);

const adminAutomation=read('src/platform/admin-automation.js');
assert(adminAutomation.includes('Affiliate rewards'),'Automation UI must describe affiliate reward qualification');

const plansList=read('src/platform/admin-plans-list.js');
assert(!/buy .*credits|credit wallet/i.test(plansList),'Unified Plans must not revive retired credit-wallet semantics');

const compose=read('docker-compose.yml');
assert(/automation-worker:[\s\S]*scripts\/automation-worker\.js/.test(compose),'Compose must run the dedicated automation worker');
assert(!/captainfin_proxy/.test(compose),'unused captainfin_proxy network must not return');

const readiness=read('scripts/production-readiness.js');
assert(!readiness.includes('JELLYFIN_ALLOWED_HOSTS'),'readiness must not require the retired Jellyfin host allowlist');
for(const expected of ['provider-settings','request-service-settings','email-settings','plan-servers'])assert(readiness.includes(expected),`readiness must use canonical ${expected} service`);

const runtimeSettings=read('src/platform/runtime-settings.js');
assert(!/process\.env\.SITE_NAME\s*=/.test(runtimeSettings),'runtime settings must never mutate process.env.SITE_NAME');
const sourceFiles=walk(path.join(ROOT,'src')).filter(file=>file.endsWith('.js'));
for(const file of sourceFiles){const text=fs.readFileSync(file,'utf8');assert(!/process\.env\.SITE_NAME\s*=/.test(text),`${rel(file)} mutates SITE_NAME at runtime`);assert(!/db\/data\.json|db\\data\.json/.test(text),`${rel(file)} still depends on the JSON-era database`);}

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

const drift=read('src/jellyfin/drift-control.js');
assert(drift.includes("method:'GET'")||drift.includes("method: 'GET'"),'drift audit must explicitly use read-only Jellyfin GET');
assert(exists('scripts/jellyfin-drift-smoke.js'),'current-schema Policy Drift smoke test must exist');

console.log(`platform coherence static contract: ok (${sourceFiles.length} source files inspected; affiliate runtime active, retired-product runtime absent)`);