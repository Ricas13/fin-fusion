'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const migration=read('db/migrations/000_database_baseline.sql');
const integrity=migration;
const transactional=migration;
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
const navModel=require('../src/platform/admin-nav');
const adminHtml=read('src/platform/admin-html.js');
const adminHtmlCore=read('src/platform/admin-html-core-base.js');
const notificationTabs=read('src/platform/notification-workflow-tabs.js');
const connectionsTabs=read('src/platform/integration-workflow-tabs.js');
const adminProfile=read('src/platform/admin-profile-account.js');
const provisioning=read('src/jellyfin/provisioning-helpers.js');
const platformRouter=read('src/platform/router.js');
const globalNotifications=read('src/platform/admin-notification-preferences.js');
const personalNotifications=read('src/platform/admin-personal-notification-preferences-v2.js');
const personalTests=read('src/platform/admin-personal-notification-tests.js');
const personalTestUi=read('public/js/admin-personal-notification-tests.js');

// Historical/provider integrity remains currency-aware even though the live
// portal exposes exactly one master commercial currency at a time.
assert(/CREATE TABLE (?:IF NOT EXISTS )?(?:public\.)?plan_prices/.test(migration),'Migration must retain historical/provider price rows');
assert(/UNIQUE\s*\(\s*plan_id,\s*currency\s*\)/.test(migration),'A logical plan may have at most one stored price row per currency');
assert(/plan_price_id uuid/i.test(migration)&&/REFERENCES public\.plan_prices|REFERENCES plan_prices/i.test(migration),'Provider mappings must belong to a stored price row');
assert(/preferred_currency (?:CHAR|character)\(3\)/i.test(migration),'Legacy preferred-currency storage must remain migration-compatible during retirement');
assert(/FOREIGN KEY\s*\(\s*plan_price_id,\s*plan_id\s*\) REFERENCES (?:public\.)?plan_prices\s*\(\s*id,\s*plan_id\s*\)/.test(integrity),'Provider mapping must not point at another logical plan price');
assert(integrity.includes('snapshot_subscription_multicurrency_contract'),'Subscription rows must preserve the historical price/provider mapping snapshot contract');
assert(/customer\.subscription\.requested[\s\S]+both[\s\S]+false/i.test(transactional),'Mandatory customer acknowledgement events must stay customer-addressable without becoming optional customer toggles');

assert(pricing.includes("const CURRENCIES=Object.freeze(['GBP','USD','EUR'])"),'Pricing storage must explicitly understand GBP/USD/EUR');
assert(pricing.includes('const wanted=await platformDefaultCurrency()'),'Live plan decoration must resolve the master portal currency');
assert(providerPricing.includes('JOIN plan_prices pr ON pr.plan_id=p.id AND pr.active=TRUE'),'Checkout provider resolution must join an active price row');
assert(providerPricing.includes('const c=await pricing.platformDefaultCurrency()'),'Checkout provider resolution must derive currency from the platform setting');
assert(providerPricing.includes('pr.currency=$3'),'Checkout provider resolution must bind mappings to the master currency row');
assert(checkout.includes('async function requestedCurrency(_req){return planPricing.platformDefaultCurrency();}'),'Checkout must ignore customer/session currency input');
assert(!checkout.includes('req.session?.storefrontCurrency'),'Checkout must not retain storefront-selected currency state');
assert(checkout.includes('planPriceId:p.plan_price_id'),'Commercial snapshots must persist the selected plan price');
assert(checkout.includes('providerMappingRecordId:p.provider_mapping_id'),'Commercial snapshots must persist the selected provider mapping record');
assert(intents.includes('plan_price_id')&&intents.includes('snapshot.planPriceId'),'Checkout intent verification must bind the immutable snapshot to the selected price row');
assert(stripe.includes('resolvedPlan')&&stripe.includes('internal_plan_price_id'),'Stripe checkout must use the already-resolved master-currency price');
assert(paypal.includes('resolvedPlan')&&paypal.includes('currency_code:String(plan.currency).toUpperCase()'),'PayPal one-time checkout must use the already-resolved master currency');
assert(validator.includes('JOIN plan_prices pr ON pr.id=pp.plan_price_id'),'Provider mapping verification must validate the exact stored amount/currency');
assert(commerce.includes('Portal currency'),'Plan Commerce must present one portal-wide currency');
assert(!commerce.includes('Multi-currency pricing'),'Plan Commerce must not expose multi-currency plan configuration');
assert(commerce.includes('Plan price changed; re-verification required.'),'Editing a price must invalidate provider verification');
assert(storefront.includes("function currencySwitcher(_currency,_currencies){return'';}"),'Storefront must not expose a customer currency switcher');
assert(storefront.includes('async function selectedCurrency(_req){return planPricing.platformDefaultCurrency();}'),'Storefront must derive currency from the master setting');
assert(communications.includes("customer_opt_in_allowed=TRUE AND event_scope IN ('customer','both')"),'Customer event catalogue must be server-filtered to globally permitted customer events');
const settingsGroup=navModel.groups.find(group=>group.key==='settings');
const settingsKeys=settingsGroup?.pages?.map(page=>page[0])||[];
assert(!settingsKeys.includes('notification-settings')&&navModel.hiddenPages?.['notification-settings']?.parentKey==='settings-integrations','Global Notifications must remain under Settings → Connections without consuming a duplicate sidebar slot');
assert(!settingsKeys.includes('my-profile'),'Personal administrator profile must stay out of global Settings navigation');
assert(!settingsKeys.includes('my-notifications'),'Per-admin notifications must not be duplicated in the global Settings sidebar');
assert(navModel.hiddenPages?.['my-profile']&&navModel.hiddenPages?.['my-notifications']&&navModel.hiddenPages?.['my-security'],'Personal admin pages must keep explicit My account workflow metadata');
assert(adminHtmlCore.includes('<div class="headerActionLabel">My account</div>')&&adminHtmlCore.includes('href="/admin/profile">My profile')&&adminHtmlCore.includes('href="/admin/profile/notifications">My notifications')&&adminHtmlCore.includes('href="/admin/security">My security'),'Administrators need discoverable My profile, My notifications and My security links under My account');
assert(!settingsKeys.includes('settings-commerce')&&navModel.hiddenPages?.['settings-commerce']?.groupKey==='commerce'&&navModel.hiddenPages?.['settings-commerce']?.parentKey==='plans'&&navModel.hiddenPages?.['settings-commerce']?.kind==='setting'&&navModel.settingsFor('plans').some(page=>page[0]==='settings-commerce'&&page[2]==='/admin/settings/commerce'),'Commerce settings must remain a Plans-owned setting without consuming a Settings rail destination');
assert(nav.includes("'my-notifications':Object.freeze"),'Hidden My Notifications workflow metadata must remain explicit');

// Global notification pages must reuse the single stable Connections workflow.
assert(notificationTabs.includes("require('./integration-workflow-tabs')"),'Global Notifications must delegate to the shared Connections workflow');
assert(connectionsTabs.includes("'connections','Connections','/admin/settings/integrations'"),'Connections workflow must expose the overview');
assert(connectionsTabs.includes("'notifications','Notifications','/admin/notifications/preferences'"),'Connections workflow must expose global notification settings');
assert(connectionsTabs.includes("'email','Email infrastructure','/admin/notifications'"),'Connections workflow must expose canonical email infrastructure and delivery health together');
assert(connectionsTabs.includes("'requests','Request service','/admin/request-users'"),'Connections workflow must expose Request service');
assert(!connectionsTabs.includes('Delivery health'),'Delivery health must not reappear as a fifth, competing Connections destination');
assert(notificationTabs.includes("'profile','Profile','/admin/profile'"),'My Profile workflow must expose personal account settings');
assert(notificationTabs.includes("'personal','Notifications','/admin/profile/notifications'"),'My Profile workflow must expose personal notification routing');
assert(adminHtml.includes("notificationWorkflow.globalTabs"),'Global notification layouts must keep a stable global workflow tab set');
assert(adminHtml.includes("notificationWorkflow.profileTabs('profile')")&&adminHtml.includes("notificationWorkflow.profileTabs('personal')"),'My Profile and My Notifications must share a stable personal workflow tab set');
assert(platformRouter.includes('createAdminProfileAccountRouter'),'Administrator profile routes must be mounted in the assembled platform router');
assert(adminProfile.includes("r.get('/admin/email'")&&adminProfile.includes("'/admin/notifications/email'"),'Legacy /admin/email must remain compatible with the email infrastructure page');
assert(adminProfile.includes("r.get('/admin/notifications/email'")&&adminProfile.includes('emailInfrastructurePage(req)'),'Legacy /admin/notifications/email must remain compatible while navigation uses /admin/notifications');
assert(!adminProfile.includes('/admin/profile/currency')&&!adminProfile.includes('Reporting currency'),'My Profile must not expose a personal currency setting');
assert(adminProfile.includes("UPDATE app_users SET email=$2")&&adminProfile.includes("UPDATE customers SET email=$2"),'Changing administrator email must also keep an attached personal customer profile in sync');
assert(adminProfile.includes("INSERT INTO customers(user_id,display_name,email,provisioning_mode,registration_source,note)"),'Personal media access must attach a customer record to the existing administrator user');
assert(adminProfile.includes("'admin_grant'")&&adminProfile.includes('provisioning.reconcileCustomer(created.customerId)'),'Personal media access must use an explicit admin grant and the normal Jellyfin reconciliation path');
assert(!adminProfile.includes("UPDATE app_users SET role='customer'"),'Creating personal media access must never demote the administrator account');
assert(adminProfile.includes("r.post('/admin/profile/media/jellyfin/:accountId/password',setPersonalJellyfinPassword)"),'Personal admins must have a scoped Jellyfin password setup route');
assert(adminProfile.includes('WHERE c.user_id=$1 AND ja.id=$2'),'Personal Jellyfin password updates must be ownership-scoped to the signed-in administrator');
assert(adminProfile.includes('provisioning.setJellyfinPassword(row.customer_id,req.params.accountId,password)'),'Personal Jellyfin password updates must use the normal password service');
assert(adminProfile.includes('autocomplete="new-password"')&&adminProfile.includes('confirmPassword'),'My Profile must provide password and confirmation fields without exposing a stored password');
assert(provisioning.includes("row.user_role==='admin'&&row.registration_source==='admin_personal'"),'Provisioning must recognize role-preserving personal administrator media profiles');
assert(provisioning.includes('Settings > My Profile'),'Personal administrator onboarding must direct password setup to My Profile instead of the customer portal');

// Route ownership: the global notification module must not carry a second,
// filtered-out implementation of the personal profile workflow. The v2
// personal router is the sole owner of all /admin/profile/notifications paths.
for(const route of [
  "/admin/notifications/preferences'",
  '/admin/notifications/preferences/delivery',
  '/admin/notifications/preferences/test-telegram',
  '/admin/notifications/preferences/test-discord',
  '/admin/notifications/preferences/outbox/:id/retry'
]) assert(globalNotifications.includes(route),`Global notifications missing canonical route ${route}`);
assert(!globalNotifications.includes("r.use('/admin/profile/notifications'")&&!globalNotifications.includes("r.get('/admin/profile/notifications'")&&!globalNotifications.includes("r.post('/admin/profile/notifications'"),'Global notification router must not contain dead duplicate personal notification routes');
for(const route of [
  "/admin/profile/notifications'",
  '/admin/profile/notifications/currency',
  '/admin/profile/notifications/telegram/start',
  '/admin/profile/notifications/telegram/unlink',
  '/admin/profile/notifications/discord/start',
  '/admin/profile/notifications/discord/callback',
  '/admin/profile/notifications/discord/unlink',
  '/admin/profile/notifications/whatsapp'
]) assert(personalNotifications.includes(route),`Personal v2 notifications missing canonical route ${route}`);

assert(platformRouter.includes('createAdminPersonalNotificationTestsRouter'),'Personal notification test routes must be mounted in the assembled platform router');
for(const channel of ['email','telegram','discord','whatsapp'])assert(personalTests.includes(`/admin/profile/notifications/test/${channel}`),`Personal ${channel} delivery must have a test route`);
assert(personalTests.includes("notificationSettings.sendDiscord(testText(site,'Discord'),{userId:me.discord_user_id})"),'Discord test must send a real DM to the linked admin identity');
assert(personalTests.includes("notificationSettings.sendTelegram(testText(site,'Telegram'),{chatId:me.telegram_chat_id})"),'Telegram test must send to the linked admin chat');
assert(personalTests.includes("notificationSettings.sendWhatsapp(testText(site,'WhatsApp'),{to:me.phone_e164})"),'WhatsApp test must use the saved opted-in admin phone');
assert(personalTests.includes("emailSettings.send({to:me.email"),'Email test must use the signed-in administrator email');
assert(personalTests.includes("'admin.notifications.personal.test'"),'Personal delivery tests must be audit logged without masquerading as business events');
assert(personalTestUi.includes('Send test Discord')&&personalTestUi.includes('Send test Telegram')&&personalTestUi.includes('Send test WhatsApp'),'My Notifications must expose real delivery test buttons');
assert(adminHtml.includes('/js/admin-personal-notification-tests.js'),'The personal notification test controls must be loaded on My Notifications');

console.log('notification + master currency smoke: ok');
