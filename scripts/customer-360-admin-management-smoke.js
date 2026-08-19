'use strict';

const fs=require('fs');
const path=require('path');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const assert=(condition,message)=>{if(!condition)throw new Error(message);};

const migration=read('db/migrations/017_stremio_install_credential_recovery.sql');
const recovery=read('src/stremio/install-credential-recovery.js');
const customerStremio=read('src/platform/customer-stremio.js');
const management=read('src/platform/admin-customer-management.js');
const composition=read('src/platform/admin-route-composition.js');
const operator=read('public/js/operator-experience.js');

assert(migration.includes('CREATE TABLE public.stremio_install_credential_recovery'),'Stremio install recovery migration is missing');
assert(migration.includes('credential_encrypted text NOT NULL'),'recoverable install credentials must be encrypted at rest');
assert(!migration.includes('credential text NOT NULL'),'raw Stremio credentials must never be stored as plaintext');
assert(recovery.includes("encryptWithEnv(String(credential),KEY_ENV,PREFIX)"),'Stremio recovery must encrypt credentials before persistence');
assert(recovery.includes('current_token_version')&&recovery.includes("row.status!=='active'"),'recovered credentials must be rejected when the live entitlement/token version no longer matches');
assert(customerStremio.includes('installRecovery.save(')&&customerStremio.includes('installRecovery.current('),'customer-issued Stremio URLs must remain recoverable after page reload');
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
assert(management.includes("password_changed_at")&&management.includes('Use the onboarding link'),'portal accounts must not be enabled before onboarding has established a customer password');
assert(management.includes("'admin.customer.portal.enrol'")&&management.includes("'admin.customer.account.update'")&&management.includes("'admin.customer.service.reconcile'"),'high-impact Customer 360 management changes must be audited');
assert(management.includes('activation.activeForUser')&&management.includes('/activate/${encodeURIComponent(row.raw)}'),'active onboarding links must be recoverable from Customer management');
assert(management.includes('activation.create({userId')&&management.includes('A fresh onboarding link was generated'),'admins must be able to regenerate missed onboarding links');
assert(management.includes('Generate / rotate installation URL')&&management.includes('Manifest / installation URL'),'Stremio install details must be visible and recoverable from Customer management');
assert(management.includes("serviceType:type")&&management.includes('hasJellyfinAccount'),'Customer 360 must expose service-aware action context');
assert(management.includes('data-native-submit="true"'),'single-customer plan/expiry actions must bypass inline AJAX form handling');

assert(composition.indexOf('createAdminCustomerManagementRouter()')<composition.indexOf('createAdminCustomer360Router()'),'customer management routes must mount before the wildcard Customer 360 route');
assert(operator.includes("appendTopAction('Manage customer'"),'Customer 360 must expose the management workspace');
assert(operator.includes('if(context.hasJellyfinAccount)appendTopAction(\'Change Jellyfin password\''),'Jellyfin password support must only appear for customers with a real Jellyfin account');
assert(!operator.includes("link.textContent='Change Jellyfin password';link.setAttribute('data-customer-password-support'"),'the old unconditional Jellyfin password action must not return');
assert(operator.includes("form.dataset.nativeSubmit='true'"),'Customer 360 bulk preview controls must submit as full-page workflows');
assert(operator.includes('repairCustomerVerificationMarkup'),'escaped email-verification pill markup must be repaired safely in Customer 360');
assert(operator.includes("accessTab.textContent='Stremio'"),'Stremio-only customers must not be sent to Jellyfin-centric access controls');

console.log('customer 360 admin management smoke: ok');
