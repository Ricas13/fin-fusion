'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.resolve(__dirname,'..'),p=(...parts)=>path.join(root,...parts),read=file=>fs.readFileSync(p(file),'utf8'),exists=file=>fs.existsSync(p(file));
function mustContain(file,pattern,message){const text=read(file);assert(pattern instanceof RegExp?pattern.test(text):text.includes(pattern),message||`${file} must contain ${pattern}`);}
function mustNotContain(file,pattern,message){const text=read(file);assert(!(pattern instanceof RegExp?pattern.test(text):text.includes(pattern)),message||`${file} must not contain ${pattern}`);}
function walk(dir){const out=[];for(const entry of fs.readdirSync(p(dir),{withFileTypes:true})){const rel=path.join(dir,entry.name);if(entry.isDirectory())out.push(...walk(rel));else out.push(rel);}return out;}

// Keep the historical 71-point completion manifest intact, while validating
// today's product architecture: affiliates/service credit for referrals and a
// separate monthly-seat reseller product with no reseller credit wallet.
const checklist=read('docs/FULL_SWEEP_71_CHECKLIST.md'),entries=[...checklist.matchAll(/^- \[x\] (\d{2})\./gm)].map(m=>m[1]);
assert.strictEqual(entries.length,71,`full-sweep manifest must contain exactly 71 completed items, found ${entries.length}`);
assert.deepStrictEqual(entries,Array.from({length:71},(_,i)=>String(i+1).padStart(2,'0')),'full-sweep manifest numbering must be exactly 01..71');

for(const file of [
  'db/migrations/085_canonical_free_tier.sql','db/migrations/088_affiliate_service_credits.sql',
  'db/migrations/089_affiliate_credit_checkout_reservations.sql','db/migrations/090_preserve_subscription_sources_with_service_credit.sql',
  'src/application.js','src/affiliate-credits.js','src/referrals.js','src/payments/service-credit-reservations.js',
  'src/payments/checkout-intents.js','src/platform/customer-affiliate.js','views/customer/affiliate.ejs',
  'src/platform/admin-referrals.js','src/platform/storefront.js','src/platform/admin-plan-order.js',
  'src/platform/reseller-monthly-portal.js','src/resellers/monthly.js','src/resellers/managed-users.js','public/css/reseller-portal.css',
  'public/js/admin-plan-order.js','scripts/affiliate-service-credit-smoke.js','scripts/affiliate-mixed-payment-smoke.js',
  'scripts/automation-worker.js','scripts/check-js-syntax.js'
])assert(exists(file),`${file} is required by the current acceptance contract`);

for(const file of ['import_users.js','check-expired.js','src/platform/reseller-portal.js','src/platform/reseller-storefront.js','src/platform/admin-business.js','src/platform/admin-shell.js','views/reseller/dashboard.ejs'])assert(!exists(file),`${file} is obsolete/dead and must remain removed`);

mustContain('package.json','node src/application.js');
mustContain('src/application.js','createCustomerSubscriptionActionsRouter');
mustContain('src/application.js','createAdminReferralsRouter');
mustContain('src/application.js','createResellerMonthlyPortalRouter','The monthly reseller seat-management portal must be mounted.');
mustContain('src/application.js','app.use(createResellerMonthlyPortalRouter())','The reseller portal must be reachable after reseller login.');
mustNotContain('src/application.js','createResellerTierChangesRouter','Retired reseller credit-era tier-change routes must not be mounted.');
mustNotContain('src/application.js','createResellerBusinessRouter','Retired reseller business/ledger portal routes must not be mounted.');
mustNotContain('src/application.js',"require('./platform/reseller-portal')");
mustNotContain('src/application.js','The reseller programme has been retired','The live monthly reseller product must not be blanket-retired.');

// Monthly reseller product invariants: fixed managed-user allowance and policy,
// with subscription billing but no credit wallet/downstream customer ledger.
mustContain('src/platform/reseller-monthly-portal.js','managedUsers.createManagedUser');
mustContain('src/platform/reseller-monthly-portal.js','managedUsers.setPassword');
mustContain('src/platform/reseller-monthly-portal.js','monthly.resellerEntitlement');
mustContain('src/platform/reseller-monthly-portal.js','/reseller/billing/stripe');
mustContain('src/platform/reseller-monthly-portal.js','/reseller/billing/paypal');
mustContain('src/resellers/managed-users.js','assertSeatAvailable');
mustContain('src/resellers/monthly.js','allow_video_transcoding','Monthly reseller entitlement must expose the configured Jellyfin transcoding policy.');
mustContain('src/resellers/monthly.js','library_access_mode','Monthly reseller entitlement must expose the configured Jellyfin library policy.');
mustNotContain('src/platform/reseller-monthly-portal.js',/\/reseller\/(?:credits|wallet)/i);
mustNotContain('src/platform/reseller-monthly-portal.js',/credit balance|buy credits|spend credits/i);

// Affiliate/service-credit product invariants.
mustContain('src/referrals.js','rewardIfQualifying');
mustContain('src/referrals.js',"entry_type,state,referral_redemption_id");
mustContain('src/referrals.js','affiliateCredits.reverseReward');
mustContain('src/affiliate-credits.js',"'active','service_credit'");
mustContain('src/affiliate-credits.js','redeemPlan');
mustContain('src/payments/service-credit-reservations.js','reserveForIntent');
mustContain('src/payments/service-credit-reservations.js',"state='reserved'");
mustContain('src/payments/service-credit-reservations.js',"'redeemed'");
mustContain('src/payments/checkout-intents.js','serviceCreditReservations.settle');
mustContain('src/platform/flexible-checkout.js','applyServiceCredit');
mustContain('src/platform/flexible-checkout.js','serviceCreditMinor');
mustContain('src/payments/stripe.js',"duration:'once'");
mustContain('src/payments/paypal.js','Service credit cannot be combined with a recurring PayPal subscription');
mustContain('views/customer/affiliate.ejs','Use credit + Stripe');
mustContain('views/customer/affiliate.ejs','Use credit + PayPal');
mustContain('views/customer/dashboard.ejs','Benefits');
mustContain('views/customer/dashboard.ejs','/account/affiliate');
mustNotContain('views/customer/dashboard.ejs','Refer a friend');
mustNotContain('src/platform/bulk-operations.js',/reseller_assign|reseller_detach/);

// Historical subscription sources remain readable during migration even when
// the old reseller-credit acquisition path is no longer a live product.
for(const source of ['manual','reseller_credit','stripe','paypal','migration','free_claim','reseller_sale','admin_grant','invitation','service_credit'])mustContain('db/migrations/090_preserve_subscription_sources_with_service_credit.sql',`'${source}'`);

// Free Access is permanent as a product rule, but customer-facing copy stays simple.
mustContain('src/platform/storefront.js','freeTierPanel');
mustContain('src/platform/storefront.js','Free access');
mustNotContain('src/platform/storefront.js','Permanent free tier');
mustContain('src/platform/admin-plan-order.js','data-order-list');
mustContain('public/js/admin-plan-order.js','dragstart');
mustContain('db/migrations/085_canonical_free_tier.sql','plans_single_free_tier_idx');

// Portable configuration retains affiliate settings and must never recreate
// the obsolete reseller credit defaults. Reseller catalogue transfer is tested
// separately as the monthly-plan configuration model is consolidated.
mustContain('src/platform/configuration-transfer.js','affiliate_program');
mustContain('src/platform/configuration-transfer.js','delete document.configuration.settings.reseller_defaults');

// Normal admin/customer safety and lifecycle ownership.
mustContain('src/payments/lifecycle.js',"p.audience IN ('direct','both')");
mustContain('src/payments/lifecycle.js','free_claim');
mustContain('src/entitlements/subscription-state.js','effectiveSubscription');
mustContain('src/payments/incidents.js',/type\s*:\s*['"]payment_risk['"]/);
mustContain('src/platform/webhooks.js','STRIPE_RISK');
mustContain('src/platform/webhooks.js','PAYPAL_RISK');
mustContain('src/platform/configuration-transfer.js','payment_risk_policy');
mustContain('src/platform/setup-readiness.js','Customer commerce');
mustContain('src/platform/setup-readiness.js',"key:'direct-payments'");
mustContain('src/platform/setup-readiness.js',"key:'affiliates'");

mustContain('src/platform/admin-original-settings.js',"require('../integrations/email-settings')");
mustContain('src/platform/admin-original-settings.js',"require('../integrations/notification-settings')");
mustContain('src/platform/admin-original-settings.js','/admin/settings/abuse-protection');
mustContain('src/platform/admin-original-settings.js','/admin/notifications/email');
mustContain('src/platform/admin-original-settings.js','/admin/request-users');
mustContain('src/platform/admin-original-settings.js','/admin/notifications/preferences');
mustContain('src/platform/admin-original-settings.js','/admin/configuration');
mustNotContain('src/platform/admin-original-settings.js','Regular credits');
mustContain('src/platform/admin-original-settings.js','/admin/settings/resellers','Reseller security must remain reachable for the live monthly reseller product.');
mustContain('src/platform/admin-original-settings.js','Reseller security');
mustNotContain('src/platform/admin-original-settings.js',/reseller credit|credit wallet|buy reseller credits/i,'Reseller settings must not revive reseller-credit semantics.');

mustContain('views/customer/dashboard.ejs','/account/subscription/renewal');
mustContain('views/customer/dashboard.ejs','Stop renewal');
mustContain('src/platform/customer-history.js','customer_plan_changes');
mustContain('src/platform/admin-events.js',"'incident' kind");
mustContain('src/platform/admin-servers.js','serverImpact');
mustContain('src/platform/admin-plans.js','Impact preview');
mustContain('docker-compose.yml','automation-worker:');
mustNotContain('docker-compose.yml','captainfin_proxy');
mustNotContain('src/platform/runtime-settings.js',/process\.env\.SITE_NAME\s*=/);
mustNotContain('scripts/production-readiness.js','JELLYFIN_ALLOWED_HOSTS');

const routinePlatformFiles=walk('src/platform').filter(file=>file.endsWith('.js')&&!/(admin-security|reseller-security|account-activation-router)/.test(file)),routineAdminViews=exists('views/admin')?walk('views/admin').filter(file=>file.endsWith('.ejs')):[];
const routine2faViolations=[];
for(const file of [...routinePlatformFiles,...routineAdminViews]){
  const text=read(file),hasCodeInput=/name=["']code["']/i.test(text);
  if(hasCodeInput&&/Authenticator\s*\/\s*recovery code/i.test(text))routine2faViolations.push(`${file}: routine fake 2FA prompt`);
  if(hasCodeInput&&/only needed if 2FA is enabled/i.test(text))routine2faViolations.push(`${file}: routine step-up 2FA description`);
}
assert.strictEqual(routine2faViolations.length,0,`routine 2FA prompts must be removed:\n${routine2faViolations.join('\n')}`);

for(const file of ['.env.example','README.md','ROADMAP.md','src/platform/admin-servers.js','views/admin/server-form.ejs','src/platform/setup-readiness.js','scripts/production-readiness.js'])if(exists(file))mustNotContain(file,'JELLYFIN_ALLOWED_HOSTS');
mustNotContain('README.md','admin/admin123');
mustNotContain('README.md','node app.js');
mustContain('README.md','PostgreSQL is authoritative');
mustContain('README.md','Affiliate and service-credit model');
mustContain('README.md','not the production architecture');

console.log('full sweep acceptance: 71/71 manifest and current monthly-reseller + affiliate/service-credit contracts OK');
