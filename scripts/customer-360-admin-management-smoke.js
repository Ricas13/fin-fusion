'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/017_stremio_install_credential_recovery.sql');
const deletionMigration=read('db/migrations/100_customer_deletion_saga.sql');
const recovery=read('src/stremio/install-credential-recovery.js');
const entitlements=read('src/stremio/entitlements.js');
const customerStremio=read('src/platform/customer-stremio.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const management=read('src/platform/admin-customer-management.js');
const accessHoldsAdmin=read('src/platform/admin-customer-access-holds.js');
const accessControlService=read('src/access/admin-customer-access-control.js');
const customer360Route=read('src/platform/admin-customer-360.js');
const customerProfileService=read('src/customers/admin-customer-profile-service.js');
const customerProfile=require('../src/customers/admin-customer-profile-service');
const customerIdentityService=read('src/customers/admin-customer-identity-service.js');
const automationProtectionService=read('src/access/admin-customer-automation-protection.js');
const individualActionService=read('src/access/admin-customer-individual-action-service.js');
const accessSettingsService=read('src/access/admin-customer-access-settings.js');
const directLifecycleService=read('src/access/admin-customer-lifecycle-service.js');
const billingControl=read('src/payments/billing-control.js');
const deletion=read('src/customers/customer-deletion.js');
const externalDeletion=read('src/customers/customer-external-deletion.js');
const automationJobs=read('src/automation/jobs.js');
const composition=read('src/platform/admin-route-composition.js');
const operator=read('public/js/operator-experience.js');
const customerOperatorClient=read('public/js/admin-customer-operator.js');
const customerPrimaryActionsClient=read('public/js/admin-customer-primary-actions.js');
const customerClaimUi=read('public/js/admin-customer-claim.js');
const customerClaims=read('src/customer-claims.js');
const adminHtml=read('src/platform/admin-html.js');
const adminHtmlCore=read('src/platform/admin-html-core.js');

assert(migration.includes('CREATE TABLE public.stremio_install_credential_recovery'),'Stremio install recovery migration is missing');
assert(migration.includes('credential_encrypted text NOT NULL'),'recoverable install credentials must be encrypted at rest');
assert(!migration.includes('credential text NOT NULL'),'raw Stremio credentials must never be stored as plaintext');
assert(recovery.includes("encryptWithEnv(String(credential),KEY_ENV,PREFIX)"),'Stremio recovery must encrypt credentials before persistence');
assert(recovery.includes('current_token_version')&&recovery.includes("row.status!=='active'"),'recovered credentials must be rejected when the live entitlement/token version no longer matches');
assert(entitlements.includes('installRecovery.save({customerId,entitlement:r.rows[0],credential:issued.token,actorUserId},{client})')&&customerDashboard.includes('installRecovery.current('),'customer-issued Stremio URLs must be persisted atomically by the canonical issuance owner and remain recoverable after page reload through Account Home');
assert(customerStremio.includes('async function issueCustomerInstallation')&&customerStremio.includes('stremio.issueInstallation(customerId,{actorUserId})')&&customerStremio.includes('issueCustomerInstallation(req.session.customerId,{actorUserId:req.session.customerUserId})'),'customer Stremio install route must delegate recovery persistence to the canonical issuance owner through the shared installation helper');
assert(entitlements.includes('installRecovery.clear(customerId)'),'canonical Stremio revoke must delete the recoverable credential');

for(const route of [
  '/admin/users/:customerId/manage',
  '/admin/users/:customerId/manage/context',
  '/admin/users/:customerId/manage/portal/enrol',
  '/admin/users/:customerId/manage/account',
  '/admin/users/:customerId/manage/email/verify',
  '/admin/users/:customerId/manage/email/unverify',
  '/admin/users/:customerId/manage/activation/rotate',
  '/admin/users/:customerId/manage/portal/status',
  '/admin/users/:customerId/manage/stremio/install',
  '/admin/users/:customerId/manage/stremio/revoke'
])assert(management.includes(route),`customer management route missing: ${route}`);
assert(accessHoldsAdmin.includes("router.post('/admin/users/:customerId/manage/reconcile',reconcileRoute)")&&accessHoldsAdmin.includes("router.post('/admin/users/:customerId/reconcile',reconcileRoute)"),'canonical Customer 360 reconciliation routes must share one blocker-aware owner');
assert(!management.includes("r.post('/admin/users/:customerId/manage/reconcile'"),'legacy customer-management router must not re-own reconciliation');

assert(customer360Route.includes("require('../customers/admin-customer-profile-service')"),
  'Customer 360 profile route must delegate profile/portal identity mutation to the customer domain');
assert(!customer360Route.includes('UPDATE customers SET display_name')
    && !customer360Route.includes('UPDATE app_users SET username=$2,email=$3'),
  'Customer 360 router must not own profile or portal-identity persistence');
assert(customerProfileService.includes('transaction(async client =>')
    && customerProfileService.includes('SELECT user_id FROM customers WHERE id=$1 FOR UPDATE')
    && customerProfileService.includes('UPDATE app_users')
    && customerProfileService.includes('UPDATE customers')
    && customerProfileService.includes("'admin.customer.profile.update'"),
  'customer profile domain service must own the atomic profile/portal update and audit event');
const normalizedProfile=customerProfile.normalizeProfileInput({
  displayName:'  Alice  ',
  countryCode:'gb',
  discordUserId:'12345',
  tags:' VIP, beta,VIP ',
  username:'alice.user',
  email:'ALICE@EXAMPLE.COM'
});
assert(normalizedProfile.displayName==='Alice'
    && normalizedProfile.country==='GB'
    && normalizedProfile.email==='alice@example.com'
    && normalizedProfile.tags.join(',')==='VIP,beta'
    && normalizedProfile.portalFieldsProvided===true,
  'customer profile service must preserve existing normalization semantics');
const truncatedCountry=customerProfile.normalizeProfileInput({countryCode:'GBR'});
assert(truncatedCountry.country==='GB','customer profile service must preserve the existing two-character country-code normalization semantics');
let invalidDiscordRejected=false;
try{customerProfile.normalizeProfileInput({discordUserId:'abc'});}catch(error){invalidDiscordRejected=error.message==='discord';}
assert(invalidDiscordRejected,'customer profile service must preserve Discord ID validation semantics');

assert(customer360Route.includes("customerIdentity.verifyEmail(")
    && !customer360Route.includes('UPDATE app_users SET email_verified_at=COALESCE'),
  'Customer 360 email verification must delegate identity persistence out of the router');
assert(customerIdentityService.includes('FOR UPDATE')
    && customerIdentityService.includes('UPDATE app_users')
    && customerIdentityService.includes("'admin.customer.email.verify'"),
  'customer identity service must own manual email verification and its audit event');
assert(customer360Route.includes('automationProtection.setAutomationProtection(')
    && !customer360Route.includes('UPDATE customers SET automation_protected='),
  'Customer 360 automation protection must delegate cleanup-authority persistence');
assert(automationProtectionService.includes("require('../entitlements/permanent-access')")
    && automationProtectionService.includes('Remove permanent access before disabling automatic cleanup protection.')
    && automationProtectionService.includes('UPDATE customers')
    && automationProtectionService.includes("'admin.customer.automation_protection'"),
  'access domain must own automation-protection policy, mutation and audit');
assert(customer360Route.includes('individualActions.resetExpiryToPlan(')
    && !customer360Route.includes('UPDATE subscriptions SET current_period_end='),
  'Customer 360 reset-to-plan expiry must delegate subscription mutation out of the router');
assert(individualActionService.includes('async function resetExpiryToPlan')
    && individualActionService.includes('subscriptionState.effectiveSubscription(customerId,{includeBlocked:true})')
    && individualActionService.includes("'admin.customer.expiry.reset_to_plan'"),
  'access-domain individual action service must own reset-to-plan expiry selection, mutation and audit');

assert(customer360Route.includes('lifecycleService.resetAutomaticPlacement(')
    && !customer360Route.includes("require('../jellyfin/server-migration')"),
  'Customer 360 automatic placement must delegate migration orchestration to the access lifecycle service');
assert(directLifecycleService.includes('async function resetAutomaticPlacement')
    && directLifecycleService.includes("require('../jellyfin/server-migration')")
    && directLifecycleService.includes('serverMigration.createMigration(')
    && directLifecycleService.includes('serverMigration.executeMigration('),
  'access lifecycle service must own automatic placement and migration orchestration');
assert(customer360Route.includes('accessCommands.permanentAccessStatus('),
  'Customer 360 must read permanent-access status through the access-domain command owner');
assert(customer360Route.includes("require('../access/admin-customer-access-settings')")
    && !customer360Route.includes("require('../db')")
    && !/\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/.test(customer360Route),
  'Customer 360 router must remain free of direct database mutation ownership');
for(const delegated of [
  'accessSettings.savePolicyOverrides(',
  'accessSettings.resetPolicyOverrides(',
  'accessSettings.saveHouseholdOverrides(',
  'accessSettings.resetHouseholdOverrides(',
  'accessSettings.saveLibraryOverrides(',
  'accessSettings.resetLibraryOverrides(',
  'accessSettings.saveRequestPermissionOverrides(',
  'accessSettings.resetRequestPermissionOverrides('
]) assert(customer360Route.includes(delegated),`Customer 360 must delegate ${delegated}`);
for(const action of [
  'admin.customer.policy_override',
  'admin.customer.policy_override_reset_all',
  'admin.customer.household_override',
  'admin.customer.household_override_reset_all',
  'admin.customer.library_override',
  'admin.customer.library_override_reset_all',
  'admin.customer.request_permission_override',
  'admin.customer.request_permission_override_reset_all'
]) assert(accessSettingsService.includes(action),`access settings service must own audit action ${action}`);
assert(accessSettingsService.includes("require('./customer-access-state')")
    && accessSettingsService.includes('customerAccessState.snapshot(customerId)'),
  'Customer 360 access settings must derive current lane entitlements from canonical customer access state');

assert(customer360Route.includes('accessSettings.resetStremioHousehold(')
    && !customer360Route.includes("require('../stremio/entitlements')")
    && !customer360Route.includes("require('../stremio/household-access')"),
  'Customer 360 Stremio household reset must delegate entitlement validation and lease release');
assert(accessSettingsService.includes('async function resetStremioHousehold')
    && accessSettingsService.includes('stremioEntitlements.current(customerId)')
    && accessSettingsService.includes('stremioHouseholdAccess.release(entitlement'),
  'access settings service must own Stremio household reset policy and mutation');
assert(customer360Route.includes('billingControl.setCustomerRenewal(')
    && !customer360Route.includes('function currentSubscription(')
    && !customer360Route.includes('billingControl.setRenewal('),
  'Customer 360 renewal must delegate canonical subscription selection to payments');
assert(billingControl.includes('async function setCustomerRenewal')
    && billingControl.includes("subscriptionState.effectiveSubscription(customerId, { includeBlocked: true })")
    && billingControl.includes('return setRenewal(current.subscription_id || current.id, enabled, actorUserId, options)'),
  'billing control must own Customer 360 renewal subscription selection before provider mutation');

assert(management.includes("session_version=session_version+1"),'disabling/enabling portal access must invalidate existing sessions');
assert(management.includes('UPDATE account_activation_tokens SET revoked_at=NOW()'),'disabling portal access must revoke unused onboarding links so they cannot reactivate the account');
assert(management.includes("password_changed_at")&&management.includes('Use the onboarding link'),'portal accounts must not be enabled before onboarding has established a customer password');
assert(management.includes("'admin.customer.portal.enrol'")&&management.includes("'admin.customer.account.update'")&&accessControlService.includes("'admin.customer.service.reconcile'"),'high-impact Customer 360 management changes must be audited by their canonical owners');
assert(management.includes('activation.activeForUser')&&management.includes('/activate/${encodeURIComponent(row.raw)}'),'active onboarding links must be recoverable from Customer management');
assert(management.includes('activation.create({userId')&&management.includes('A fresh onboarding link was generated'),'admins must be able to regenerate missed onboarding links');
assert(management.includes('Generate / rotate installation URL')&&management.includes('Manifest / installation URL'),'Stremio install details must be visible and recoverable from Customer management');
assert(management.includes('activeSubscriptions(detail)')&&management.includes("if(primary==='jellyfin'&&hasStremio)return'bundle'"),'Customer management must treat an active Stremio add-on alongside Jellyfin as combined service access');
assert(accessControlService.includes('provisioning.reconcileCustomer(customerId)')&&!accessControlService.includes('stremio.reconcileForCustomer'),'single-customer reconciliation must delegate once to the canonical service-aware reconciler rather than running Stremio twice');
assert(accessHoldsAdmin.includes("require('../access/admin-customer-access-control')")&&!accessHoldsAdmin.includes('UPDATE customer_bans')&&!accessHoldsAdmin.includes('UPDATE customer_access_holds'),'access-holds router must delegate access mutation SQL to the access domain');
assert(management.includes("serviceType:type")&&management.includes('hasJellyfinAccount'),'Customer 360 must expose service-aware action context');
assert(management.includes('data-native-submit="true"'),'single-customer plan/expiry actions must bypass inline AJAX form handling');

// Hard deletion is a cross-system saga: persist every access-bearing target
// before destructive work, then perform irreversible local cleanup through one
// constrained DB finalizer only after all blocking targets are confirmed absent.
assert(deletionMigration.includes('CREATE TABLE IF NOT EXISTS public.customer_deletion_jobs'),'hard deletion must have durable operation state');
assert(deletionMigration.includes("WHERE status IN ('pending','running','failed')")&&deletionMigration.includes('customer_deletion_jobs_one_active_customer_idx'),'only one unfinished hard deletion may own a customer');
assert(deletion.includes('enqueueHardDelete(customerId')&&deletion.includes('processDeletionJob(job.id)'),'admin hard delete must enqueue durably before attempting destructive work');
assert(externalDeletion.includes("provider:'jellyfin'")&&externalDeletion.includes("resourceType:'user'")&&externalDeletion.includes("desiredState:'absent'"),'hard deletion must snapshot Jellyfin identities as durable absent targets before remote removal');
assert(externalDeletion.includes("Number(error?.status)===404")&&externalDeletion.includes("status:'already_missing'"),'remote 404 must be a successful resumable deletion outcome');
assert(deletion.includes("CUSTOMER_DELETION_PENDING")&&deletion.includes("status='failed'")&&deletion.includes('next_attempt_at=NOW()+make_interval'),'failed deletion must persist a retryable state with backoff');
assert(deletion.includes("SELECT public.finalize_customer_deletion($1) AS result"),'portal cleanup must cross the constrained privileged finalization boundary only after remote confirmation is persisted');
const confirmationGuard=deletionMigration.indexOf('COALESCE(confirmed_accounts,0) <> expected_accounts');
const localDelete=deletionMigration.indexOf('DELETE FROM public.jellyfin_accounts WHERE customer_id=j.customer_id;');
assert(confirmationGuard>=0&&localDelete>confirmationGuard,'local Jellyfin rows must not be removed until the finalizer verifies all remote identities');
assert(/UPDATE public\.customer_deletion_jobs\r?\n    SET status='succeeded'/.test(deletionMigration)&&deletionMigration.includes("'admin.customer.hard_delete'"),'portal cleanup, deletion completion and audit must share the final database transaction');
assert(automationJobs.includes("async customer_deletions(){return customerDeletion.processDue({limit:10})}"),'automation worker must retry due/stale customer deletion jobs');

assert(composition.indexOf('createAdminCustomerManagementRouter()')<composition.indexOf('createAdminCustomer360Router()'),'customer management routes must mount before the wildcard Customer 360 route');

assert(management.includes('function accessPath(')&&management.includes('return res.redirect(accessPath(req.params.customerId,key,message))'),'GET /manage must redirect into the canonical Access tab and preserve feedback instead of rendering a second page');
assert(management.includes('return res.redirect(accessPath(id,key,message,anchor))'),'folded /manage mutations must return directly to the Customer workspace with their success/error message');
assert(!management.includes('function page(req)')&&!management.includes('function identitySection(')&&!management.includes('function serviceSection('),'the standalone /manage page renderer and its now-duplicated identity/service sections must remain retired');
assert(management.includes('module.exports=')&&management.includes('portalSection')&&management.includes('stremioSection')&&management.includes('activationState')&&management.includes('stremioState'),'management helpers must remain exported for the workspaces that still own them');

const view360=read('src/platform/customer-360-view.js');
const compact360=read('src/platform/customer-360-compact.js');
const primaryActions=read('src/platform/admin-customer-primary-actions.js');
const directIndividual=read('src/platform/admin-customer-individual-actions.js');
const directLifecycle=read('src/platform/admin-customer-direct-lifecycle.js');
const accessCards=read('src/platform/customer-360-access-cards.js');
assert(view360.includes("compact=require('./customer-360-compact')")&&view360.includes('compact.render(safe,token,options)'),'the focused Customer 360 renderer must own the default operator page');
for(const title of ['Customer / Portal','Plans & Subscriptions','Jellyfin / Emby','Stremio','Overseerr','Discord','Access / Holds','Danger Zone'])assert(compact360.includes(title),`action-first Customer 360 is missing ${title}`);
assert(compact360.includes('accessCards.accessLibrariesRequests(detail,token,options)')&&compact360.includes('Permissions, libraries & requests…'),'lane-aware access/library/request overrides must remain available as a secondary action inside the service control panel');
assert(!compact360.includes('bulkForm(')&&!compact360.includes('/admin/customers/bulk/preview'),'Customer 360 compact single-customer actions must not submit through the bulk preview workflow');
assert(!primaryActions.includes('/admin/customers/bulk/preview')&&primaryActions.includes('/admin/users/${encodeURIComponent(id)}/move-server'),'Customer 360 primary actions must route server movement directly instead of through bulk preview');
assert(compact360.includes("customerLink(id,'change-plan','Change plan'")&&compact360.includes("customerLink(id,'subscriptions/revoke','Revoke a plan'")&&compact360.includes("customerLink(id,'move-server','Move Jellyfin server'")&&compact360.includes("customerLink(id,'delete-customer','Review permanent deletion'"),'Customer 360 must expose direct plan-change, targeted subscription-revoke, server-move and permanent-delete workflows');
assert(directIndividual.includes("COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')"),'individual subscription actions must only target Jellyfin-capable subscriptions');
assert(directLifecycle.includes('lifecycleService.moveServer(')&&directLifecycleService.includes('return forceMove.move(customerId,serverId')&&directLifecycle.includes('ownerStatus(req.session.authUserId)')&&directLifecycle.includes('deletion.hardDeletePortalCustomer'),'single-customer lifecycle routes must reuse canonical move/deletion safeguards through the domain boundary');
assert(directLifecycle.includes("serviceScope=require('../entitlements/service-scope')")&&directLifecycle.includes("function jellyfinCapable(row){return serviceScope.capabilities(row).has('jellyfin');}")&&directLifecycle.includes('serviceScope.overlaps(sub,plan)&&jellyfinCapable(plan)')&&directLifecycleService.includes('!serviceScope.overlaps(sub,target)||!jellyfinCapable(target)'),'single-customer plan changes must only offer and accept service-compatible Jellyfin-capable target plans');
assert(directLifecycle.includes('!(subscriptionState.recurringProvider(sub)&&planExpiry.isFreeTier(plan))')&&directLifecycleService.includes('subscriptionState.recurringProvider(sub)&&planExpiry.isFreeTier(target)'),'recurring provider subscriptions must not be manually moved to the free tier while provider billing remains active');
assert(directLifecycleService.includes('planChange.currentRecurring(customerId,target)')&&directLifecycleService.includes('planChange.requestChange({')&&directLifecycleService.includes('customerId,targetPlanCode:target.code')&&!directLifecycle.includes('applyManualEntitlementContract'),'recurring Customer 360 plan changes must use the canonical provider-aware plan-change service rather than a local-only entitlement rewrite');
assert(directLifecycleService.includes("result.mode==='immediate'")&&directLifecycleService.includes('Provider billing changed successfully, but access reconciliation needs retry'),'provider-accepted plan changes must not be reported as failed only because downstream access reconciliation needs retry');
assert(composition.includes('createAdminCustomerIndividualActionsRouter()')&&composition.includes('createAdminCustomerDirectLifecycleRouter()'),'direct Customer 360 action routers must be mounted explicitly');
assert(compact360.includes('/access-holds/${encodeURIComponent(hold.id)}/release')&&compact360.includes('Type RELEASE'),'hold release must remain a typed-confirm canonical workflow');
assert(compact360.includes("disclosure('Activity'")&&compact360.includes("disclosure('Payments'")&&compact360.includes("disclosure('Logs'"),'only the three operator-support disclosures must own lower-page history/technical data');
assert(!compact360.includes('Jellyfin account details')&&!compact360.includes('Service reconciliation truth'),'redundant account-detail and diagnostic tables must stay off the main action-first page');
assert(accessCards.includes('Access, libraries &amp; requests')&&accessCards.includes('Reset to plan'),'canonical lane override renderer must remain available to the action-first wrapper');

// Imported Jellyfin customers use the dedicated claim flow, not ordinary portal
// activation. The page enhancement is deliberately progressive; the server-side
// createClaim guard remains the security boundary if a stale page submits after
// another administrator has already claimed the customer.
assert(adminHtmlCore.includes('/js/admin-customer-claim.js'),'canonical admin pages must load the contextual imported-customer claim controller');
assert(customerClaimUi.includes("location.pathname.match(/^\\/admin\\/users\\/([0-9a-f-]{36})$/i)")&&customerClaimUi.includes("return !tab || tab === 'overview'"),'portal invite enhancement must be scoped to the individual customer Overview only');
assert(customerClaimUi.includes("valueFor(card, 'Portal username') !== '—'")&&customerClaimUi.includes('Portal account not claimed'),'claimed customers must not receive the imported-customer invite control');
assert(customerClaimUi.includes('/admin/customer-claims/${encodeURIComponent(id)}/create')&&customerClaimUi.includes('New customer claim link'),'the customer Overview must reuse the canonical claim-link endpoint and its one-time bearer response');
assert(customerClaimUi.includes('their Jellyfin password is not changed')&&customerClaimUi.includes('Creating another link revokes the previous unused link'),'invite copy must preserve the imported-account safety semantics');
assert(customerClaims.includes("if(customer.user_id)throw new Error('This customer already has a CAPTAiNFiN portal account.')"),'claim backend must reject a customer that has already acquired a portal identity');
assert(customerClaims.includes('UPDATE customers SET user_id=$2')&&customerClaims.includes("jellyfinPasswordChanged:false"),'claim completion must create/link the portal identity without changing the existing Jellyfin password');

assert(operator.includes("appendTopAction('Manage customer'"),'legacy operator enrichment must remain compatible until the customer-specific stabilizer runs');
assert(operator.includes('if(context.hasJellyfinAccount)appendTopAction(\'Change Jellyfin password\''),'Jellyfin password support context must remain available to the legacy enrichment layer');
assert(!operator.includes("link.textContent='Change Jellyfin password';link.setAttribute('data-customer-password-support'"),'the old unconditional Jellyfin password action must not return');
assert(operator.includes("form.dataset.nativeSubmit='true'"),'Customer 360 bulk preview controls must submit as full-page workflows');
assert(operator.includes('repairCustomerVerificationMarkup'),'escaped email-verification pill markup must be repaired safely in Customer 360');

// Customer 360 remains one server-rendered page with only one record nav entry
// plus the Portal view action. The retired multi-tab navigation stabilizer must
// not return now that operational actions live directly in the eight cards.
const customer360View=read('src/platform/customer-360-view.js');
assert(customer360View.includes('Customer record')&&customer360View.includes('detailTab active'),'Customer 360 must keep one active "Customer record" nav entry');
assert(!fs.existsSync(path.join(root,'src/platform/customer-360-view-v2.js')),'retired Customer 360 V2 renderer must not return');
assert(!fs.existsSync(path.join(root,'public/js/customer-360-navigation.js')),'the retired multi-tab navigation stabilizer must not be reintroduced');
assert(!adminHtml.includes('/js/customer-360-navigation.js'),'admin pages must no longer load the retired Customer 360 navigation stabilizer');
assert(customerOperatorClient.includes('relocatePortalAndTopActions'),'the impersonation relocation into the customer nav must remain available to the legacy enrichment layer');
assert(!customerPrimaryActionsClient.includes('foldPaymentIncidents')&&!customerPrimaryActionsClient.includes('customerPaymentIncidentsFolded'),'Customer 360 client enhancement must not retain the removed duplicate payment-incident folding layer');
assert(!customerPrimaryActionsClient.includes('min-height:238px!important')&&customerPrimaryActionsClient.includes('min-height:0!important'),'Customer 360 client enhancement must not reintroduce fixed card heights after the server renderer removed them');

console.log('customer 360 admin management smoke: ok');
