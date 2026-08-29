'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/017_stremio_install_credential_recovery.sql');
const deletionMigration=read('db/migrations/100_customer_deletion_saga.sql');
const recovery=read('src/stremio/install-credential-recovery.js');
const customerStremio=read('src/platform/customer-stremio.js');
const customerDashboard=read('src/platform/customer-dashboard.js');
const management=read('src/platform/admin-customer-management.js');
const deletion=read('src/platform/customer-deletion.js');
const automationJobs=read('src/automation/jobs.js');
const composition=read('src/platform/admin-route-composition.js');
const operator=read('public/js/operator-experience.js');
const stableNavigation=read('public/js/customer-360-navigation.js');
const adminHtml=read('src/platform/admin-html.js');

assert(migration.includes('CREATE TABLE public.stremio_install_credential_recovery'),'Stremio install recovery migration is missing');
assert(migration.includes('credential_encrypted text NOT NULL'),'recoverable install credentials must be encrypted at rest');
assert(!migration.includes('credential text NOT NULL'),'raw Stremio credentials must never be stored as plaintext');
assert(recovery.includes("encryptWithEnv(String(credential),KEY_ENV,PREFIX)"),'Stremio recovery must encrypt credentials before persistence');
assert(recovery.includes('current_token_version')&&recovery.includes("row.status!=='active'"),'recovered credentials must be rejected when the live entitlement/token version no longer matches');
assert(customerStremio.includes('installRecovery.save(')&&customerDashboard.includes('installRecovery.current('),'customer-issued Stremio URLs must remain recoverable after page reload through Account Home');
assert(customerStremio.includes('installRecovery.clear('),'revoking Stremio must delete the recoverable credential');

for(const route of [
  '/admin/users/:customerId/manage',
  '/admin/users/:customerId/manage/context',
  '/admin/users/:customerId/manage/portal/enrol',
  '/admin/users/:customerId/manage/account',
  '/admin/users/:customerId/manage/email/verify',
  '/admin/users/:customerId/manage/email/unverify',
  '/admin/users/:customerId/manage/activation/rotate',
  '/admin/users/:customerId/manage/portal/status',
  '/admin/users/:customerId/manage/reconcile',
  '/admin/users/:customerId/manage/stremio/install',
  '/admin/users/:customerId/manage/stremio/revoke'
])assert(management.includes(route),`customer management route missing: ${route}`);

assert(management.includes("session_version=session_version+1"),'disabling/enabling portal access must invalidate existing sessions');
assert(management.includes('UPDATE account_activation_tokens SET revoked_at=NOW()'),'disabling portal access must revoke unused onboarding links so they cannot reactivate the account');
assert(management.includes("password_changed_at")&&management.includes('Use the onboarding link'),'portal accounts must not be enabled before onboarding has established a customer password');
assert(management.includes("'admin.customer.portal.enrol'")&&management.includes("'admin.customer.account.update'")&&management.includes("'admin.customer.service.reconcile'"),'high-impact Customer 360 management changes must be audited');
assert(management.includes('activation.activeForUser')&&management.includes('/activate/${encodeURIComponent(row.raw)}'),'active onboarding links must be recoverable from Customer management');
assert(management.includes('activation.create({userId')&&management.includes('A fresh onboarding link was generated'),'admins must be able to regenerate missed onboarding links');
assert(management.includes('Generate / rotate installation URL')&&management.includes('Manifest / installation URL'),'Stremio install details must be visible and recoverable from Customer management');
assert(management.includes('activeSubscriptions(detail)')&&management.includes("if(primary==='jellyfin'&&hasStremio)return'bundle'"),'Customer management must treat an active Stremio add-on alongside Jellyfin as combined service access');
assert(management.includes('stremio.entitledSubscription(req.params.customerId)')&&management.includes('stremio.reconcileForCustomer(req.params.customerId,stremioEntitlement)'),'service reconciliation must preserve and reconcile active Stremio add-ons');
assert(management.includes("serviceType:type")&&management.includes('hasJellyfinAccount'),'Customer 360 must expose service-aware action context');
assert(management.includes('data-native-submit="true"'),'single-customer plan/expiry actions must bypass inline AJAX form handling');

// Hard deletion is a cross-system saga: keep the customer/access inventory until
// every remote Jellyfin identity has been confirmed deleted or already missing,
// then perform the irreversible local cleanup through one constrained DB finalizer.
assert(deletionMigration.includes('CREATE TABLE IF NOT EXISTS public.customer_deletion_jobs'),'hard deletion must have durable operation state');
assert(deletionMigration.includes("WHERE status IN ('pending','running','failed')")&&deletionMigration.includes('customer_deletion_jobs_one_active_customer_idx'),'only one unfinished hard deletion may own a customer');
assert(deletion.includes('enqueueHardDelete(customerId')&&deletion.includes('processDeletionJob(job.id)'),'admin hard delete must enqueue durably before attempting destructive work');
assert(deletion.includes('holdAccess:false,removeLocal:false,continueOnMissing:true'),'hard deletion remote phase must retain every local Jellyfin row for retry');
assert(deletion.includes("Number(error?.status)===404")&&deletion.includes("status:'already_missing'"),'remote 404 must be a successful resumable deletion outcome');
assert(deletion.includes("CUSTOMER_DELETION_PENDING")&&deletion.includes("status='failed'")&&deletion.includes('next_attempt_at=NOW()+make_interval'),'failed deletion must persist a retryable state with backoff');
assert(deletion.includes("SELECT public.finalize_customer_deletion($1) AS result"),'portal cleanup must cross the constrained privileged finalization boundary only after remote confirmation is persisted');
const confirmationGuard=deletionMigration.indexOf('COALESCE(confirmed_accounts,0) <> expected_accounts');
const localDelete=deletionMigration.indexOf('DELETE FROM public.jellyfin_accounts WHERE customer_id=j.customer_id;');
assert(confirmationGuard>=0&&localDelete>confirmationGuard,'local Jellyfin rows must not be removed until the finalizer verifies all remote identities');
assert(deletionMigration.includes("UPDATE public.customer_deletion_jobs\n    SET status='succeeded'")&&deletionMigration.includes("'admin.customer.hard_delete'"),'portal cleanup, deletion completion and audit must share the final database transaction');
assert(automationJobs.includes("async customer_deletions(){return customerDeletion.processDue({limit:10})}"),'automation worker must retry due/stale customer deletion jobs');

assert(composition.indexOf('createAdminCustomerManagementRouter()')<composition.indexOf('createAdminCustomer360Router()'),'customer management routes must mount before the wildcard Customer 360 route');

assert(/res\.redirect\(`\/admin\/users\/\$\{encodeURIComponent\(req\.params\.customerId\)\}\?tab=access`\)/.test(management),'GET /manage must redirect into the canonical Access tab instead of rendering a second page');
assert(!management.includes('function page(req)')&&!management.includes('function identitySection(')&&!management.includes('function serviceSection('),'the standalone /manage page renderer and its now-duplicated identity/service sections must be removed once folded into Access');
assert(management.includes('module.exports=')&&management.includes('portalSection')&&management.includes('stremioSection')&&management.includes('activationState')&&management.includes('stremioState'),'portal and Stremio-install sections must be exported for reuse on the Customer 360 Access tab');
const view360=read('src/platform/customer-360-view.js');
assert(view360.includes("require('./admin-customer-management')")&&view360.includes('manage.portalSection(')&&view360.includes('manage.stremioSection('),'Customer 360 Access tab must render the folded-in portal/Stremio-install sections');
assert(operator.includes("appendTopAction('Manage customer'"),'legacy operator enrichment must remain compatible until the customer-specific stabilizer runs');
assert(operator.includes('if(context.hasJellyfinAccount)appendTopAction(\'Change Jellyfin password\''),'Jellyfin password support context must remain available to the legacy enrichment layer');
assert(!operator.includes("link.textContent='Change Jellyfin password';link.setAttribute('data-customer-password-support'"),'the old unconditional Jellyfin password action must not return');
assert(operator.includes("form.dataset.nativeSubmit='true'"),'Customer 360 bulk preview controls must submit as full-page workflows');
assert(operator.includes('repairCustomerVerificationMarkup'),'escaped email-verification pill markup must be repaired safely in Customer 360');

// Customer navigation is deliberately owned by one deterministic layer. Async
// service context must never rewrite Access into another workspace after the
// page has rendered.
for(const label of ["['overview','Overview'","['access','Access'","['activity','Activity'","['billing','Billing'","['security','Security'","['history','History'"]){
  assert(stableNavigation.includes(label),`stable Customer 360 navigation is missing ${label}`);
}
assert(!stableNavigation.includes("['manage','Manage'"),'Manage must no longer be a separate persistent nav tab now that /manage redirects into the Access tab');
assert(stableNavigation.includes("href===`${base}?tab=activity`"),'Activity must be removed from duplicate top-bar navigation');
assert(stableNavigation.includes('[data-customer-management],[data-customer-password-support]'),'legacy async customer top actions must be removed once represented in the stable customer workspace');
assert(stableNavigation.includes("link.setAttribute('href',href)"),'async Stremio context must not be able to mutate the canonical Access tab destination');
assert(stableNavigation.includes("nav.insertAdjacentElement('afterend',controls)"),'Customer control centre must sit beneath the stable identity/summary/navigation context');
assert(stableNavigation.includes('MutationObserver'),'late async operator enrichment must not make the customer navigation change after first paint');
assert(adminHtml.includes('/js/customer-360-navigation.js'),'Customer 360 navigation stabilizer must load on admin pages');

console.log('customer 360 admin management smoke: ok');