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
const deletion=read('src/platform/customer-deletion.js');
const externalDeletion=read('src/platform/customer-external-deletion.js');
const automationJobs=read('src/automation/jobs.js');
const composition=read('src/platform/admin-route-composition.js');
const operator=read('public/js/operator-experience.js');
const customerOperatorClient=read('public/js/admin-customer-operator.js');
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
assert(customerStremio.includes('stremio.issueInstallation(req.session.customerId,{actorUserId:req.session.customerUserId})'),'customer Stremio install route must delegate recovery persistence to the canonical issuance owner');
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

assert(management.includes("session_version=session_version+1"),'disabling/enabling portal access must invalidate existing sessions');
assert(management.includes('UPDATE account_activation_tokens SET revoked_at=NOW()'),'disabling portal access must revoke unused onboarding links so they cannot reactivate the account');
assert(management.includes("password_changed_at")&&management.includes('Use the onboarding link'),'portal accounts must not be enabled before onboarding has established a customer password');
assert(management.includes("'admin.customer.portal.enrol'")&&management.includes("'admin.customer.account.update'")&&accessHoldsAdmin.includes("'admin.customer.service.reconcile'"),'high-impact Customer 360 management changes must be audited by their canonical owners');
assert(management.includes('activation.activeForUser')&&management.includes('/activate/${encodeURIComponent(row.raw)}'),'active onboarding links must be recoverable from Customer management');
assert(management.includes('activation.create({userId')&&management.includes('A fresh onboarding link was generated'),'admins must be able to regenerate missed onboarding links');
assert(management.includes('Generate / rotate installation URL')&&management.includes('Manifest / installation URL'),'Stremio install details must be visible and recoverable from Customer management');
assert(management.includes('activeSubscriptions(detail)')&&management.includes("if(primary==='jellyfin'&&hasStremio)return'bundle'"),'Customer management must treat an active Stremio add-on alongside Jellyfin as combined service access');
assert(accessHoldsAdmin.includes('provisioning.reconcileCustomer(customerId)')&&!accessHoldsAdmin.includes('stremio.reconcileForCustomer'),'single-customer reconciliation must delegate once to the canonical service-aware reconciler rather than running Stremio twice');
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
assert(deletionMigration.includes("UPDATE public.customer_deletion_jobs\n    SET status='succeeded'")&&deletionMigration.includes("'admin.customer.hard_delete'"),'portal cleanup, deletion completion and audit must share the final database transaction');
assert(automationJobs.includes("async customer_deletions(){return customerDeletion.processDue({limit:10})}"),'automation worker must retry due/stale customer deletion jobs');

assert(composition.indexOf('createAdminCustomerManagementRouter()')<composition.indexOf('createAdminCustomer360Router()'),'customer management routes must mount before the wildcard Customer 360 route');

assert(management.includes('function accessPath(')&&management.includes('return res.redirect(accessPath(req.params.customerId,key,message))'),'GET /manage must redirect into the canonical Access tab and preserve feedback instead of rendering a second page');
assert(management.includes('return res.redirect(accessPath(id,key,message,anchor))'),'folded /manage mutations must return directly to the Customer workspace with their success/error message');
assert(!management.includes('function page(req)')&&!management.includes('function identitySection(')&&!management.includes('function serviceSection('),'the standalone /manage page renderer and its now-duplicated identity/service sections must remain retired');
assert(management.includes('module.exports=')&&management.includes('portalSection')&&management.includes('stremioSection')&&management.includes('activationState')&&management.includes('stremioState'),'management helpers must remain exported for the workspaces that still own them');

const view360=read('src/platform/customer-360-view.js');
const accessCards=read('src/platform/customer-360-access-cards.js');
assert(accessCards.includes("require('./admin-customer-management')")&&accessCards.includes('manage.stremioSection('),'Customer 360 must retain Stremio installation controls for Stremio/bundle access');
assert(view360.includes("accessCards=require('./customer-360-access-cards')")&&view360.includes('accessCards.render('),'the dedicated compact Access renderer must own Jellyfin access controls');
assert(accessCards.includes('Customer control')&&accessCards.includes('ctlGrid')&&accessCards.includes('Access, libraries &amp; requests'),'Customer 360 must expose the consolidated Customer control grid and lane-aware Access/Libraries/Requests panels');
assert(accessCards.includes("bulkPreviewForm(token,customerId,'migrate_server','Move server (guided)'")&&accessCards.includes('Reset to plan'),'Customer 360 must keep customer-scoped server movement and reset-to-plan operations');
assert(accessCards.includes('Provisioning history')&&accessCards.includes('Activity'),'large diagnostic tables must remain available as capped/collapsed lower sections');

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

// Customer 360 is a single server-rendered page now (Customer control grid +
// lane-aware Access/Libraries/Requests + Billing + Overview/Security/History
// folded in below), so the client-side multi-tab navigation stabilizer this
// used to guard against async rewrites is retired along with the tab bar it
// stabilized. Only the impersonation ("Portal view") relocation remains, and
// that runs from admin-customer-operator.js.
const viewV2=read('src/platform/customer-360-view-v2.js');
assert(viewV2.includes('Customer record')&&viewV2.includes('detailTab active'),'Customer 360 must keep one active "Customer record" nav entry');
assert(!fs.existsSync(path.join(root,'public/js/customer-360-navigation.js')),'the retired multi-tab navigation stabilizer must not be reintroduced');
assert(!adminHtml.includes('/js/customer-360-navigation.js'),'admin pages must no longer load the retired Customer 360 navigation stabilizer');
assert(customerOperatorClient.includes('relocatePortalAndTopActions'),'the impersonation relocation into the customer nav must remain available to the legacy enrichment layer');

console.log('customer 360 admin management smoke: ok');
