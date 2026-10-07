'use strict';

const fs=require('fs');
const path=require('path');
const assert=require('assert');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

function jsFiles(dir){
  const rows=[];
  for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
    const full=path.join(dir,entry.name);
    if(entry.isDirectory())rows.push(...jsFiles(full));
    else if(entry.isFile()&&entry.name.endsWith('.js'))rows.push(full);
  }
  return rows;
}
function relative(file){return path.relative(root,file).replace(/\\/g,'/');}
function importers(fragment){return jsFiles(path.join(root,'src')).filter(file=>read(relative(file)).includes(fragment)).map(relative).sort();}

// Authentication: one public facade owns explicit step-up semantics. The old
// service-core compatibility path is intentionally gone now that nothing calls it.
assert(!fs.existsSync(path.join(root,'src/auth/service-core.js')),'retired auth compatibility facade must stay removed');
const auth=read('src/auth/service.js');
assert(auth.includes("require('./service-engine')"),'canonical auth service must use the internal engine');
assert(!auth.includes("require('./service-core')"),'canonical auth service must not depend on its historical alias');
assert(auth.includes('pendingStaffAuth=prior||{stepUp:true'),'canonical auth service must preserve explicit step-up enforcement');
assert.deepStrictEqual(importers("require('./service-engine')"),['src/auth/service.js'],'only the canonical auth facade may import service-engine');

// Admin security: only the canonical facade may compose step-up and mutation guards.
assert(!fs.existsSync(path.join(root,'src/platform/admin-security-core.js')),'retired admin-security compatibility facade must stay removed');
const adminSecurity=read('src/platform/admin-security.js');
assert(adminSecurity.includes("require('./admin-security-routes')"),'canonical admin security facade must use internal routes');
assert(adminSecurity.includes('createAdminStepUpRouter')&&adminSecurity.includes('sensitiveMutationGuard'),'canonical admin security facade must retain step-up and sensitive mutation guards');
assert.deepStrictEqual(importers("require('./admin-security-routes')"),['src/platform/admin-security.js'],'only the canonical admin security facade may import internal security routes');

// Jellyfin provisioning: the historical compatibility facade is gone. Low-level
// helpers are dependency-safe, and all customer reconciliation mutations belong
// to the resilient multi-service owner. No source module may reintroduce the old
// facade as a shortcut around that ownership boundary.
assert(!fs.existsSync(path.join(root,'src/jellyfin/provisioning-core.js')),'retired provisioning-core compatibility facade must stay removed');
assert(!fs.existsSync(path.join(root,'src/jellyfin/provisioning.js')),'retired provisioning compatibility facade must stay removed');
const provisioningHelpers=read('src/jellyfin/provisioning-helpers.js');
const provisioningEngine=read('src/jellyfin/provisioning-engine.js');
const resilientProvisioning=read('src/jellyfin/resilient-provisioning.js');
const subscriptionExpiry=read('src/entitlements/subscription-expiry.js');
assert(provisioningHelpers.includes("require('./provisioning-engine')"),'dependency-safe helper surface must own the internal engine import');
assert(resilientProvisioning.includes("require('./provisioning-helpers')"),'canonical reconciler must consume helpers directly');
assert(!resilientProvisioning.includes("require('./provisioning')"),'canonical reconciler must never depend on the retired compatibility facade');
assert.deepStrictEqual(importers("require('./provisioning')"),[],'no source module may import the retired same-directory provisioning facade');
assert.deepStrictEqual(importers("require('../jellyfin/provisioning')"),[],'no source module may import the retired Jellyfin provisioning facade');
assert.deepStrictEqual(importers("require('./provisioning-engine')"),['src/jellyfin/provisioning-helpers.js'],'only the dependency-safe helper module may import provisioning-engine');
assert(provisioningHelpers.includes('markPasswordSetupRequired'),'helper surface must retain password-setup state for created Jellyfin identities');
for(const retired of ['reconcileCustomer','reconcileAccount','holdAccess','releaseAccess','expireSubscriptionsAndReconcile']){
  assert(!new RegExp(`\\b${retired}\\b`).test(provisioningHelpers.split('module.exports =')[1]||''),`helper surface must never export retired mutation ${retired}`);
  assert(!new RegExp(`async function\\s+${retired}\\b`).test(provisioningEngine),`low-level provisioning engine must not retain retired mutation implementation ${retired}`);
  assert(!new RegExp(`\\b${retired}\\b`).test(provisioningEngine.split('module.exports =')[1]||''),`low-level provisioning engine must never export retired mutation ${retired}`);
}
for(const retired of ['selectServerForPlan','currentEntitlement']){
  assert(!new RegExp(`async function\\s+${retired}\\b`).test(provisioningEngine),`low-level provisioning engine must not retain canonical ownership helper ${retired}`);
  assert(!new RegExp(`\\b${retired}\\b`).test(provisioningEngine.split('module.exports =')[1]||''),`low-level provisioning engine must not export canonical ownership helper ${retired}`);
}
assert(!provisioningEngine.includes("require('./placement')")&&!provisioningEngine.includes("require('../entitlements/subscription-state')"),'primitive provisioning engine must not regain placement or entitlement dependencies');
assert(resilientProvisioning.includes('inactivityHoldReconciliation.releaseObsoleteForCustomer'),'canonical resilient provisioning must retain inactivity-hold reconciliation');
assert(resilientProvisioning.includes('autoDowngradeEligibleCustomer'),'canonical resilient provisioning must retain automatic free-tier downgrade behavior');
assert(resilientProvisioning.includes("require('../entitlements/subscription-expiry')"),'canonical mutation owner must use the entitlement expiry helper');
assert(resilientProvisioning.includes('subscriptionExpiry.expireAndReconcile'),'canonical reconciler must own expiry/reconcile composition');
assert(!resilientProvisioning.includes('WITH expired AS'),'subscription expiry SQL must not be duplicated into resilient provisioning');
assert(subscriptionExpiry.includes('WITH expired AS')&&subscriptionExpiry.includes("status IN('active','trialing','past_due','paused','cancelled')"),'canonical subscription expiry helper must own the expiry state transition');
assert.deepStrictEqual(importers("require('../entitlements/subscription-expiry')"),['src/automation/jobs.js','src/jellyfin/resilient-provisioning.js'],'subscription expiry consumers must stay limited to the automation scheduler and canonical reconciler');


// Access Integrity operator decisions belong to the access domain. The admin
// route renders findings and maps HTTP outcomes, but must not independently
// decide repairability or reimplement stale-finding revalidation.
const adminAutomation=read('src/platform/admin-automation.js');
const integrityOperator=read('src/access/access-integrity-operator.js');
assert(adminAutomation.includes("require('../access/access-integrity-operator')"),
  'admin automation must consume the Access Integrity operator service');
assert(!adminAutomation.includes("require('../access/access-integrity')")
  && !adminAutomation.includes("require('../access/access-repair')"),
  'platform adapter must not bypass the Access Integrity operator service');
assert(integrityOperator.includes("require('./access-integrity')")
  && integrityOperator.includes("require('./access-repair')")
  && integrityOperator.includes('async function repairCurrent'),
  'Access Integrity operator service must own scanner revalidation and safe repair dispatch');
assert(integrityOperator.includes("const current = await scan({ limit: 500 })")
  && integrityOperator.includes("String(item?.id || '') === normalized.id")
  && integrityOperator.includes("String(item?.customerId || '') === normalized.customerId"),
  'operator service must match the exact current scanner finding before mutation');


// Customer ban/unban, hold release and break-glass reconciliation are access-domain operations.
const adminAccessHolds=read('src/platform/admin-customer-access-holds.js');
const adminAccessControl=read('src/access/admin-customer-access-control.js');
assert(adminAccessHolds.includes("require('../access/admin-customer-access-control')"),
  'admin access-holds routes must delegate mutation ownership to access domain');
assert(!adminAccessHolds.includes('UPDATE customer_bans')
    && !adminAccessHolds.includes('UPDATE customer_access_holds')
    && !adminAccessHolds.includes('UPDATE app_users SET active=FALSE'),
  'platform access-holds router must not own ban/hold/session mutation SQL');
assert(adminAccessControl.includes('UPDATE customer_bans')
    && adminAccessControl.includes('UPDATE customer_access_holds')
    && adminAccessControl.includes('reconcileCustomerForAdmin'),
  'access domain must own serialized ban, hold and reconciliation mutations');

// Manual entitlement grant policy/SQL is an entitlement-domain operation.
const adminManualEntitlement=read('src/platform/admin-manual-entitlement.js');
const manualEntitlementService=read('src/entitlements/admin-manual-entitlement-service.js');
assert(adminManualEntitlement.includes("require('../entitlements/admin-manual-entitlement-service')"),
  'admin manual entitlement route must delegate grant ownership to entitlement domain');
assert(!adminManualEntitlement.includes('INSERT INTO subscriptions')
    && !adminManualEntitlement.includes('FROM subscriptions s')
    && !adminManualEntitlement.includes('createManualSubscriptionTx'),
  'platform manual entitlement route must not own subscription eligibility or mutation SQL');
assert(manualEntitlementService.includes('createManualSubscriptionTx')
    && manualEntitlementService.includes('FOR UPDATE')
    && manualEntitlementService.includes("source: 'admin_grant'"),
  'manual entitlement domain service must own serialized eligibility and subscription creation');

// Manual-payment recording is a payments-domain operation. The platform route
// owns HTTP/CSRF handling only; ledger mutation and its audit event are atomic.
const adminCustomerBilling=read('src/platform/admin-customer-billing.js');
const manualPaymentLedger=read('src/payments/manual-payment-ledger.js');
assert(adminCustomerBilling.includes("require('../payments/manual-payment-ledger')"),
  'admin customer billing route must delegate manual ledger ownership to payments domain');
assert(!adminCustomerBilling.includes('INSERT INTO manual_payment_events')
    && !adminCustomerBilling.includes('INSERT INTO audit_log'),
  'platform billing route must not own manual-payment or audit SQL');
assert(manualPaymentLedger.includes('transaction(async client =>')
    && manualPaymentLedger.includes('INSERT INTO manual_payment_events')
    && manualPaymentLedger.includes("'admin.customer.manual_payment.recorded'"),
  'manual payment ledger must commit the ledger event and audit event atomically');

// Customer My Access is an HTTP/presentation adapter. Customer media-account
// SQL, lane-to-entitlement selection and credential authorization belong to the
// access domain so the route cannot invent a second access truth.
const customerMyAccess=read('src/platform/customer-jellyfin.js');
const customerMediaAccess=read('src/access/customer-media-access.js');
assert(customerMyAccess.includes("require('../access/customer-media-access')"),
  'customer My Access must consume the customer media access domain service');
assert(!customerMyAccess.includes("require('../access/customer-access-state')")
    && !customerMyAccess.includes("require('../entitlements/subscription-state')"),
  'customer My Access must not bypass its media access domain service');
assert(!customerMyAccess.includes('FROM jellyfin_accounts'),
  'customer My Access must not own media account/server SQL');
assert(customerMediaAccess.includes("require('./customer-access-state')")
    && !customerMediaAccess.includes("require('../entitlements/subscription-state')"),
  'customer media access domain must consume the single canonical cross-service access-state owner');
assert(customerMediaAccess.includes('async function credentialAccess')
    && customerMediaAccess.includes('function evaluateCredentialAccess')
    && customerMediaAccess.includes('async function incompleteFreeSubscriptionId'),
  'customer media access domain must own credential authorization and incomplete-Free interpretation');

// Activation cleanup must never own the right to delete a customer while a
// provider checkout can still settle. Checkout creation takes the customer row
// lock, and cleanup must re-check both open local checkouts and attached
// provider-unresolved checkouts while holding that same owner lock.
const activationCleanup=read('src/automation/activation-cleanup.js');
assert((activationCleanup.match(/FROM billing_checkout_intents bci/g)||[]).length>=2,'activation cleanup must protect payable checkout state both during candidate classification and final delete re-check');
assert(activationCleanup.includes("bci.state='open'"),'an open checkout must protect an unactivated customer from cleanup');
assert(activationCleanup.includes('bci.provider_checkout_id IS NOT NULL')&&activationCleanup.includes('bci.provider_terminal_at IS NULL')&&activationCleanup.includes('COALESCE(bci.capacity_hold_until,bci.expires_at)>NOW()'),'locally terminal but provider-payable checkouts must stay protected until provider truth or the shared safety backstop');
assert(activationCleanup.includes('FOR UPDATE OF c,u'),'activation cleanup must serialize final deletion against checkout creation through the customer owner row');
assert(activationCleanup.includes('hasCheckout: Boolean(row.has_checkout)'),'protected-stale audit evidence must disclose checkout protection');

// Database schema ownership: migrations create the session table; web runtime only uses it.
const application=read('src/application.js');
const sessionMigration=read('db/migrations/002_add_runtime_session_store.sql');
assert(sessionMigration.includes('CREATE TABLE IF NOT EXISTS user_sessions'),'session table must remain migration-owned');
assert(/createTableIfMissing:\s*false/.test(application),'web session store must rely on migrated user_sessions');
assert(!/createTableIfMissing:\s*true/.test(application),'web runtime must never regain session-table DDL fallback');

// Customer/admin outbound notification side effects: business/domain modules
// may decide what to notify, but external delivery is durable-outbox owned.
// This prevents SMTP/Discord/Telegram calls from creeping back into request,
// billing or lifecycle code where a process crash could lose or duplicate them.
const emailOutbox=read('src/integrations/email-outbox.js');
const notificationOutbox=read('src/integrations/notification-outbox.js');
const notificationDispatch=read('src/integrations/notification-dispatch.js');
assert(emailOutbox.includes("INSERT INTO notification_outbox")
    && emailOutbox.includes("channel='email'")
    && emailOutbox.includes("status='sending'")
    && emailOutbox.includes("status='sent'")
    && emailOutbox.includes("status='dead'"),
    'email delivery must remain a durable outbox state machine');
assert(emailOutbox.includes('UNCERTAIN_DELIVERY_ERROR')
    && emailOutbox.includes('recordUncertainDelivery'),
    'SMTP success followed by persistence uncertainty must quarantine instead of blind-resending');
assert(notificationOutbox.includes("INSERT INTO notification_outbox")
    && notificationOutbox.includes("status='sending'")
    && notificationOutbox.includes("status='sent'")
    && notificationOutbox.includes("status='dead'"),
    'Discord and Telegram delivery must remain a durable outbox state machine');
assert(notificationOutbox.includes('UNCERTAIN_DELIVERY_ERROR')
    && notificationOutbox.includes('quarantineStaleSending'),
    'non-email notification delivery uncertainty must quarantine instead of blind-resending');
assert(notificationDispatch.includes('emailOutbox.enqueue(')
    && notificationDispatch.includes('notificationOutbox.enqueueTelegram(')
    && notificationDispatch.includes('notificationOutbox.enqueueDiscord('),
    'notification dispatch must enqueue external side effects instead of delivering them inline');
assert(!notificationDispatch.includes('emailSettings.send(')
    && !notificationDispatch.includes('notificationSettings.sendDiscord(')
    && !notificationDispatch.includes('notificationSettings.sendTelegram('),
    'notification dispatch must never bypass its durable outboxes');

const sourceFiles=jsFiles(path.join(root,'src'));

// Explicit administrator "send test" endpoints intentionally exercise the
// transport itself and are not lifecycle/customer notifications. Keep that
// diagnostic exception small and named; every non-test business notification
// must still enter the durable outbox.
const adminTransportTests=new Set([
  'src/platform/admin-email.js',
  'src/platform/admin-integrations-inline.js',
  'src/platform/admin-personal-notification-tests.js'
]);
for(const file of adminTransportTests){
  const source=read(file);
  assert(/send-test|\/notifications\/test\//.test(source),
    `${file} may bypass the outbox only as an explicit administrator transport test`);
}

const directEmailSenders=sourceFiles
  .filter(file=>read(relative(file)).includes('emailSettings.send('))
  .map(relative).sort();
assert.deepStrictEqual(directEmailSenders,[
  'src/platform/admin-email.js',
  'src/platform/admin-integrations-inline.js',
  'src/platform/admin-personal-notification-tests.js'
], 'only explicit administrator SMTP transport tests may bypass the email outbox');

const directDiscordSenders=sourceFiles
  .filter(file=>/\.sendDiscord(?:Channel)?\s*\(/.test(read(relative(file))))
  .map(relative).filter(file=>file!=='src/integrations/notification-outbox.js').sort();
assert.deepStrictEqual(directDiscordSenders,['src/platform/admin-personal-notification-tests.js'],
  'only the explicit administrator Discord transport test may bypass the notification outbox');

const directTelegramSenders=sourceFiles
  .filter(file=>/\.sendTelegram\s*\(/.test(read(relative(file))))
  .map(relative).filter(file=>file!=='src/integrations/notification-outbox.js').sort();
assert.deepStrictEqual(directTelegramSenders,['src/platform/admin-personal-notification-tests.js'],
  'only the explicit administrator Telegram transport test may bypass the notification outbox');

// Stremio ownership: household access remains a control-plane contract while
// the stream resource hands Stremio an isolated media-server session's
// static/original media URL directly. No CAPTAiNFiN media relay or provider
// playback-session lifecycle is allowed in that path.
const external=read('src/stremio/external-direct-runtime.js');
const managed=read('src/stremio/managed-runtime.js');
const stremioEntitlements=read('src/stremio/entitlements.js');
const managedEntitlements=read('src/stremio/managed-entitlements.js');
const stremioRuntime=read('src/stremio/runtime.js');
const jellyfinActivity=read('src/jellyfin/activity.js');
assert(!external.includes('controlPlaybackUrl')&&external.includes('directPlaybackUrl(')&&/url\.searchParams\.set\(\s*['"]Static['"]\s*,\s*['"]true['"]\s*\)/.test(external)&&external.includes("url.searchParams.set('api_key',token)")&&external.includes('externalPlaybackToken.tokenFor(source,entitlement,{returnContext:true})')&&!external.includes('client.sourceToken(source)')&&external.includes('source.media_server_type'),'external playback must return its raw-file URL directly through the stored provider using an isolated per-entitlement media-server session, never the durable source token');
assert(managed.includes("url.searchParams.set('Static','true')")&&managed.includes("url.searchParams.set('api_key',token)"),'managed playback must return its restricted hidden media-server user raw-file URL directly');
assert(!managed.includes('/PlaybackInfo')&&!stremioRuntime.includes("require('./managed-playback-lifecycle')"),'managed Stremio delivery must not negotiate or report a media-server playback session');
assert(stremioRuntime.includes("householdAccess.claim(entitlement, req, { kind: 'direct_stream_result' })"),'direct stream results must claim household access before authenticated media-server URLs leave CAPTAiNFiN');
assert(!external.includes('pipe(res)')&&!stremioRuntime.includes('pipe(res)'),'Stremio media bytes must never be relayed through CAPTAiNFiN');
assert(stremioEntitlements.includes('persistEntitlementRecord')&&stremioEntitlements.includes('managedAccountOwned'),'install-link reconciliation must not own or reset the managed hidden-user identity');
assert(managedEntitlements.includes('MaxActiveSessions:0'),'hidden managed media-server users must remain unlimited at provider session-policy level');
assert(!fs.existsSync(path.join(root,'src/stremio/source-admission.js')),'retired Stremio commercial admission module must remain absent');
assert(!stremioRuntime.includes('stream_limit')&&!stremioRuntime.includes("require('./source-admission')"),'Stremio protocol runtime must not enforce a commercial concurrent-stream quota');
assert(stremioRuntime.includes("'/stremio/:token/play/:mappingId/:itemId/:mediaSourceId'")&&stremioRuntime.includes('managedRuntime.directUrl(mapping, req.params.itemId, req.params.mediaSourceId)'),'legacy managed control links must remain compatibility-only and resolve to raw media-server delivery');
assert(stremioRuntime.includes("'/stremio/:token/external-play/:sourceId/:itemId/:mediaSourceId'")&&stremioRuntime.includes('playbackTargetFor(entitlement, req.params.sourceId, req.params.itemId, req.params.mediaSourceId)'),'legacy external control links must remain compatibility-only');
assert(/router\.get\('\/stremio\/:token\/source\/:sourceId\/:itemId\/:mediaSourceId'\s*,[\s\S]{0,120}\bretiredPlayback\s*\)/.test(stremioRuntime)&&stremioRuntime.includes("const retiredPlayback = (_req, res) => res.status(410).end()"),'legacy external proxy URLs must remain retired with 410 semantics regardless of optional route middleware');
assert((jellyfinActivity.match(/account_purpose,'jellyfin'\)<>'stremio_internal'/g)||[]).length>=2,'ordinary media concurrency monitoring must exclude hidden Stremio identities');


// Individual customer access mutations belong to the access domain; the platform module
// may render forms and validate HTTP inputs but must not own entitlement/account mutation SQL.
const individualActionRoute=read('src/platform/admin-customer-individual-actions.js');
const individualActionService=read('src/access/admin-customer-individual-action-service.js');
assert(individualActionRoute.includes("require('../access/admin-customer-individual-action-service')")
    && !individualActionRoute.includes('UPDATE subscriptions')
    && !individualActionRoute.includes('INSERT INTO subscription_service_extension_events')
    && !individualActionRoute.includes('accessHolds.addHold(')
    && !individualActionRoute.includes('serviceAdminControl.setRemoved('),
  'individual customer action router must remain an HTTP/view adapter');
assert(individualActionService.includes('UPDATE subscriptions')
    && individualActionService.includes('INSERT INTO subscription_service_extension_events')
    && individualActionService.includes('accessHolds.addHold(')
    && individualActionService.includes('serviceAdminControl.setRemoved('),
  'access-domain individual action service must own extension, expiry, suspension and Jellyfin-removal mutations');

// Customer 360 access mutations must cross one access-domain command boundary.
// The HTTP router can validate CSRF and map messages, but may not call the low-level
// manual-assignment or permanent-access implementations directly.
const customer360Route=read('src/platform/admin-customer-360.js');
const customer360AccessCommands=read('src/access/admin-customer-access-commands.js');
assert(customer360Route.includes("require('../access/admin-customer-access-commands')")
    && customer360Route.includes('accessCommands.assignServer(')
    && customer360Route.includes('accessCommands.setPermanentAccess('),
  'Customer 360 access actions must delegate through the access-domain command service');
for(const forbidden of [
  "require('../jellyfin/manual-assignment')",
  "require('../entitlements/permanent-access')",
  'manualAssignment.assign(',
  'permanentAccess.enable(',
  'permanentAccess.revoke('
]){
  assert(!customer360Route.includes(forbidden),
    `Customer 360 router must not bypass its access-domain command boundary: ${forbidden}`);
}
assert(customer360AccessCommands.includes("require('../jellyfin/manual-assignment')")
    && customer360AccessCommands.includes("require('../entitlements/permanent-access')")
    && customer360AccessCommands.includes('async function assignServer')
    && customer360AccessCommands.includes('async function setPermanentAccess'),
  'access-domain Customer 360 command service must own manual assignment and permanent-access dispatch');

// Plan creation persistence belongs to the catalog domain. The adaptive plan
// route may parse/render HTTP input, but must not own plan, price or audit writes.
const planCreateRoute=read('src/platform/admin-plan-create-v2.js');
const planCommandService=read('src/catalog/plan-command-service.js');
assert(planCreateRoute.includes("require('../catalog/plan-command-service')")
    && planCreateRoute.includes('planCommands.createPlan(plan, actorUserId)')
    && !planCreateRoute.includes("require('../db')")
    && !planCreateRoute.includes("require('../payments/plan-pricing')")
    && !planCreateRoute.includes('INSERT INTO plans')
    && !planCreateRoute.includes('INSERT INTO audit_log'),
  'adaptive plan creation must delegate persistence to the catalog command service');
assert(planCommandService.includes('async function createPlan')
    && planCommandService.includes('INSERT INTO plans')
    && planCommandService.includes('planPricing.setPrice(')
    && planCommandService.includes("'admin.plan.create'"),
  'catalog plan command service must own atomic plan creation, pricing and audit persistence');

// Core Jellyfin plan editor persistence belongs to the catalog command service.
// Provider-option verification is still handled separately, but product, availability,
// delivery/pool, libraries and commerce writes must not return to the HTTP adapter.
const jellyfinPlanEditor=read('src/platform/admin-jellyfin-plan-editor.js');
assert(jellyfinPlanEditor.includes("require('../catalog/plan-command-service')")
    && jellyfinPlanEditor.includes('planCommands.updateProduct({')
    && jellyfinPlanEditor.includes('planCommands.updateAvailability({')
    && jellyfinPlanEditor.includes('planCommands.updateDelivery({')
    && jellyfinPlanEditor.includes('planCommands.updateLibraries({')
    && jellyfinPlanEditor.includes('planCommands.updateCommerce({'),
  'Jellyfin plan editor must delegate core persistence to catalog plan commands');
for(const forbidden of [
  'UPDATE plans SET name=',
  'UPDATE plans SET capacity_limit=',
  'DELETE FROM plan_server_eligibility',
  'INSERT INTO plan_server_eligibility',
  'UPDATE plans SET library_access_mode=',
  'UPDATE plans SET billing_interval=',
  "verification_error='Plan commercial schedule changed; re-verification required.'"
]){
  assert(!jellyfinPlanEditor.includes(forbidden),
    `Jellyfin plan editor must not own catalog mutation SQL: ${forbidden}`);
}
for(const required of [
  'async function updateProduct',
  'async function updateAvailability',
  'async function updateDelivery',
  'async function updateLibraries',
  'async function updateCommerce',
  'DELETE FROM plan_server_eligibility',
  'INSERT INTO plan_server_eligibility',
  "verification_error='Plan commercial schedule changed; re-verification required.'"
]){
  assert(planCommandService.includes(required),
    `catalog plan command service must own ${required}`);
}

// Plan access and payment-option persistence belong to the catalog domain.
// Platform routes may validate/render/verify providers, but must not own the writes.
const planAccessRoute=read('src/platform/admin-plan-access.js');
const planPaymentOptionsRoute=read('src/platform/admin-plan-payment-options.js');
assert(planAccessRoute.includes("require('../catalog/plan-command-service')")
    && planAccessRoute.includes('planCommands.updateAccessPolicy({')
    && !planAccessRoute.includes('UPDATE plans SET')
    && !planAccessRoute.includes('DELETE FROM access_network_leases')
    && !planAccessRoute.includes("'admin.plan.access_policy.update'"),
  'plan access route must delegate access-policy mutation to the catalog command service');
assert(planPaymentOptionsRoute.includes("require('../catalog/plan-command-service')")
    && planPaymentOptionsRoute.includes('planCommands.updatePortalCurrencyPrice({')
    && planPaymentOptionsRoute.includes('planCommands.updatePaymentOptions({')
    && !planPaymentOptionsRoute.includes('UPDATE plan_provider_prices SET active=FALSE')
    && !planPaymentOptionsRoute.includes("'admin.plan.portal_currency_price.update'")
    && !planPaymentOptionsRoute.includes("'admin.plan.payment_options'"),
  'plan payment-options route must delegate price/mapping persistence to the catalog command service');
for(const required of [
  'async function updateAccessPolicy',
  'DELETE FROM access_network_leases',
  "'admin.plan.access_policy.update'",
  'async function saveProviderOption',
  'async function updatePaymentOptions',
  'async function updatePortalCurrencyPrice',
  "'admin.plan.portal_currency_price.update'",
  "'admin.plan.payment_options'"
]){
  assert(planCommandService.includes(required),
    `catalog plan command service must own ${required}`);
}

// Stremio plan editing uses the same catalog mutation owner as Jellyfin.
const stremioPlanEditor=read('src/platform/admin-stremio-plan-editor.js');
assert(stremioPlanEditor.includes("require('../catalog/plan-command-service')")
    && stremioPlanEditor.includes('planCommands.updateStremioCommerce({')
    && stremioPlanEditor.includes('planCommands.updateStremioStorefront({')
    && stremioPlanEditor.includes('planCommands.updateStremioAccess({')
    && stremioPlanEditor.includes('planCommands.updateStremioAvailability({')
    && stremioPlanEditor.includes('planCommands.updatePaymentOptions({'),
  'Stremio plan editor must delegate all catalogue mutations through catalog plan commands');
for(const forbidden of [
  'UPDATE plans SET name=',
  'UPDATE plans SET description=',
  'UPDATE plans SET stremio_household_network_limit=',
  'UPDATE plans SET capacity_limit=',
  'UPDATE subscriptions SET stremio_household_network_limit_snapshot=',
  'INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)'
]){
  assert(!stremioPlanEditor.includes(forbidden),
    `Stremio plan editor must not own catalogue mutation SQL: ${forbidden}`);
}
for(const required of [
  'async function updateStremioCommerce',
  'async function updateStremioStorefront',
  'async function updateStremioAccess',
  'async function updateStremioAvailability',
  "'admin.plan.stremio_commerce.update'",
  "'admin.plan.stremio_access.update'",
  "'admin.plan.stremio_availability.update'"
]){
  assert(planCommandService.includes(required),
    `catalog plan command service must own Stremio mutation ${required}`);
}

// Emby plan creation/update uses the same catalog mutation owner.
const embyPlanEditor=read('src/platform/admin-emby-plan-editor.js');
assert(embyPlanEditor.includes("require('../catalog/plan-command-service')")
    && embyPlanEditor.includes('planCommands.upsertEmbyPlan({')
    && !embyPlanEditor.includes('UPDATE plans SET name=')
    && !embyPlanEditor.includes('INSERT INTO plans(code,name,description,service_type')
    && !embyPlanEditor.includes('DELETE FROM plan_server_eligibility')
    && !embyPlanEditor.includes('INSERT INTO plan_server_eligibility'),
  'Emby plan editor must delegate catalogue persistence to the shared plan command service');
assert(planCommandService.includes('async function upsertEmbyPlan')
    && planCommandService.includes("service_type='emby'")
    && planCommandService.includes("'admin.emby_plan.update'")
    && planCommandService.includes("'admin.emby_plan.create'"),
  'catalog plan command service must own Emby plan create/update persistence and audit');

// Portable configuration import stays an atomic orchestrator and delegates each
// configuration class to its canonical write owner.
const configurationTransfer=read('src/platform/configuration-transfer.js');
assert(configurationTransfer.includes("require('../catalog/plan-command-service')")
    && configurationTransfer.includes("require('../integrations/notification-preferences-command-service')")
    && configurationTransfer.includes("require('../automation/job-health')")
    && configurationTransfer.includes("require('../configuration/platform-settings-command-service')")
    && configurationTransfer.includes('planCommands.applyImportedPlans(')
    && configurationTransfer.includes('planCommands.applyImportedProviderMappings(')
    && configurationTransfer.includes('notificationPreferenceCommands.applyImportedPreferences(')
    && configurationTransfer.includes('jobHealth.applyImportedState(')
    && configurationTransfer.includes('platformSettingsCommands.applyImportedSettings('),
  'configuration transfer must orchestrate canonical domain commands');
for(const forbidden of [
  'INSERT INTO platform_settings(',
  'INSERT INTO notification_preferences(',
  'INSERT INTO plans(',
  'UPDATE plans SET',
  'DELETE FROM plan_server_eligibility',
  'INSERT INTO plan_server_eligibility',
  'INSERT INTO plan_provider_prices',
  'UPDATE automation_job_state SET'
]){
  assert(!configurationTransfer.includes(forbidden),
    `configuration transfer must not bypass canonical mutation owners: ${forbidden}`);
}
assert(configurationTransfer.includes('transaction(async client=>')
    && configurationTransfer.includes("'admin.configuration.import.atomic'"),
  'configuration transfer must preserve one outer atomic transaction and one import-level audit event');



// Customer portal security mutations belong to the security domain. The platform
// route may render forms, verify CSRF and persist the in-memory session update,
// but password/TOTP/recovery/session database mutation must stay behind commands.
const customerSecurityRoute=read('src/platform/customer-security.js');
const customerSecurityCommands=read('src/security/customer-security-commands.js');
assert(customerSecurityRoute.includes("require('../security/customer-security-commands')")
    && customerSecurityRoute.includes('securityCommands.changePassword(')
    && customerSecurityRoute.includes('securityCommands.revokeOtherSessions(')
    && customerSecurityRoute.includes('securityCommands.disableTwoFactor(')
    && customerSecurityRoute.includes('securityCommands.regenerateRecoveryCodes('),
  'customer security routes must delegate password, session and 2FA mutations to the security domain');
for(const forbidden of [
  'customers.changePortalPassword(',
  'customers.revokeOtherCustomerSessions(',
  'UPDATE auth_sessions',
  'UPDATE app_users SET password_hash',
  'DELETE FROM auth_recovery_codes',
  'DELETE FROM auth_totp_enrollments'
]){
  assert(!customerSecurityRoute.includes(forbidden),
    `customer security platform route must not own security persistence: ${forbidden}`);
}
assert(customerSecurityCommands.includes('async function changePassword')
    && customerSecurityCommands.includes('async function revokeOtherSessions')
    && customerSecurityCommands.includes('async function disableTwoFactor')
    && customerSecurityCommands.includes('async function regenerateRecoveryCodes')
    && customerSecurityCommands.includes("'customer.password.change'")
    && customerSecurityCommands.includes("'customer.2fa.disable'"),
  'customer security command service must own password/session/2FA mutation and audit behavior');

console.log('canonical ownership smoke: ok');


// Bulk customer operations are domain/worker orchestration, never platform-owned mutation logic.
const bulkDomain=read('src/customers/bulk-operations.js');
const operatorBulkDomain=read('src/customers/operator-bulk-operations.js');
const automationJobs=read('src/automation/jobs.js');
assert(automationJobs.includes("require('../customers/bulk-operations')")
    && automationJobs.includes("require('../customers/operator-bulk-operations')"),
  'automation worker must load bulk customer handlers from the customer domain');
assert(bulkDomain.includes('UPDATE subscriptions')
    && bulkDomain.includes('subscription_service_extension_events'),
  'customer-domain bulk operations must own entitlement mutation implementation');
assert(operatorBulkDomain.includes("require('../entitlements/admin-manual-entitlement-service')")
    && operatorBulkDomain.includes("require('../access/admin-force-access-service')"),
  'operator bulk orchestration must depend on domain services rather than platform routers');

// Customer deletion is a customer-domain saga, not platform business logic.
assert(!fs.existsSync(path.join(root,'src/platform/customer-deletion.js'))
    && !fs.existsSync(path.join(root,'src/platform/customer-external-deletion.js')),
  'customer deletion saga/state-machine owners must not live in src/platform');
const customerDeletionDomain=read('src/customers/customer-deletion.js');
const externalDeletionDomain=read('src/customers/customer-external-deletion.js');
const subscriptionRevokeRoute=read('src/platform/admin-subscription-revoke.js');
const subscriptionRevokeService=read('src/entitlements/admin-subscription-revoke-service.js');
assert(customerDeletionDomain.includes("require('./customer-external-deletion')"),
  'customer deletion saga must use the customer-domain external target state machine');
assert(externalDeletionDomain.includes('customer_external_deletion_targets')
    && externalDeletionDomain.includes('terminateRecurringForDeletion'),
  'customer-domain external deletion must retain durable target and verified billing cancellation ownership');
assert(subscriptionRevokeRoute.includes("require('../entitlements/admin-subscription-revoke-service')")
    && !subscriptionRevokeRoute.includes('UPDATE subscriptions')
    && !subscriptionRevokeRoute.includes('terminateRecurringForDeletion')
    && !subscriptionRevokeRoute.includes('stremio.revoke('),
  'subscription revoke route must remain an HTTP/rendering adapter');
assert(subscriptionRevokeService.includes('UPDATE subscriptions')
    && subscriptionRevokeService.includes('terminateRecurringForDeletion')
    && subscriptionRevokeService.includes('stremio.revoke('),
  'entitlement-domain revoke service must own targeted revocation policy and mutations');

