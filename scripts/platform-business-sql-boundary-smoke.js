'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const platformRoot = path.join(root, 'src', 'platform');

const domainOwnedTables = Object.freeze([
  'subscriptions',
  'customers',
  'app_users',
  'jellyfin_accounts',
  'customer_access_holds',
  'customer_bans',
  'customer_entitlement_overrides',
  'customer_service_admin_control',
  'plans',
  'plan_provider_mappings',
  'provider_operations',
  'payment_events',
  'notification_outbox'
]);

const documentedLegacyExceptions = new Set([
]);


function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function relative(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

const observed = [];
for (const file of walk(platformRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  for (const table of domainOwnedTables) {
    const mutation = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${table}\\b`, 'i');
    if (mutation.test(source)) observed.push({ file: relative(file), table });
  }
}

const key = row => `${row.file}::${row.table}`;
const unexpected = observed.filter(row => !documentedLegacyExceptions.has(key(row)));
const observedKeys = new Set(observed.map(key));
const staleExceptions = [...documentedLegacyExceptions].filter(entry => !observedKeys.has(entry)).sort();

assert.deepStrictEqual(
  unexpected,
  [],
  `src/platform gained a new direct mutation of a domain-owned business table. Move it behind its domain owner or add a deliberately reviewed exception. Violations: ${JSON.stringify(unexpected)}`
);
assert.deepStrictEqual(
  staleExceptions,
  [],
  `A documented platform SQL exception is no longer needed; remove it from the frozen legacy allowlist: ${JSON.stringify(staleExceptions)}`
);



const adminPortalRecovery=fs.readFileSync(path.join(root,'src/platform/admin-portal-credential-recovery.js'),'utf8');
const adminPortalRecoveryOwner=fs.readFileSync(path.join(root,'src/security/admin-portal-credential-recovery.js'),'utf8');
assert(
  adminPortalRecovery.includes("require('../security/admin-portal-credential-recovery')"),
  'admin portal credential recovery must delegate destructive security mutation to the security domain'
);
for(const forbidden of [
  'UPDATE app_users',
  'UPDATE customers',
  'DELETE FROM auth_recovery_codes',
  'DELETE FROM auth_totp_enrollments',
  'UPDATE auth_sessions',
  'DELETE FROM user_sessions',
  'UPDATE account_tokens'
]){
  assert(
    !adminPortalRecovery.includes(forbidden),
    `platform recovery route must not own destructive persistence: ${forbidden}`
  );
}
for(const required of [
  'FOR UPDATE OF c,u',
  'UPDATE app_users',
  'UPDATE customers',
  'DELETE FROM auth_recovery_codes',
  'DELETE FROM auth_totp_enrollments',
  'UPDATE auth_sessions',
  'DELETE FROM user_sessions',
  'UPDATE account_tokens',
  "'admin.customer.portal_credential_recovery'"
]){
  assert(
    adminPortalRecoveryOwner.includes(required),
    `security recovery owner must retain ${required}`
  );
}
assert(
  adminPortalRecoveryOwner.includes('transaction(async client=>'),
  'admin portal credential recovery must remain one serialized transaction'
);
assert(
  adminPortalRecoveryOwner.includes('passwordPolicy.validateNewPassword(password)'),
  'admin portal credential recovery must preserve canonical password policy validation'
);


const planOrderRoute=fs.readFileSync(path.join(root,'src/platform/admin-plan-order.js'),'utf8');
const requestPlanRoute=fs.readFileSync(path.join(root,'src/platform/admin-request-plan-policy.js'),'utf8');
const planCommandService=fs.readFileSync(path.join(root,'src/catalog/plan-command-service.js'),'utf8');
assert(planOrderRoute.includes("require('../catalog/plan-command-service')")
    && planOrderRoute.includes('planCommands.updateStorefrontOrder(')
    && !planOrderRoute.includes('UPDATE plans SET sort_order'),
  'storefront ordering must delegate plan persistence to the catalog command owner');
assert(requestPlanRoute.includes("require('../catalog/plan-command-service')")
    && requestPlanRoute.includes('planCommands.updateRequestPolicy(')
    && !requestPlanRoute.includes('UPDATE plans'),
  'request-plan policy route must delegate plan persistence to the catalog command owner');
for(const required of [
  'async function updateStorefrontOrder',
  "'admin.storefront.order.update'",
  'async function updateRequestPolicy',
  "'plan.request_policy.update'",
  'FOR UPDATE',
  'request_access_enabled'
]){
  assert(planCommandService.includes(required),`catalog plan command service must own ${required}`);
}



const mediaControlsRoute=fs.readFileSync(path.join(root,'src/platform/admin-media-controls.js'),'utf8');
const serviceAuthorityRoute=fs.readFileSync(path.join(root,'src/platform/admin-service-authority.js'),'utf8');
const accessControlOwner=fs.readFileSync(path.join(root,'src/access/admin-customer-access-control.js'),'utf8');
const catalogCommands=fs.readFileSync(path.join(root,'src/catalog/plan-command-service.js'),'utf8');
assert(mediaControlsRoute.includes("require('../catalog/plan-command-service')")
    && mediaControlsRoute.includes('planCommands.updateFourKTranscodePolicy(')
    && !mediaControlsRoute.includes('UPDATE plans SET kick_4k_transcodes'),
  '4K plan mutation must stay behind the catalog command owner');
assert(catalogCommands.includes('async function updateFourKTranscodePolicy')
    && catalogCommands.includes("'admin.plan.4k_transcode_policy'"),
  'catalog command owner must retain 4K policy persistence and audit');
assert(serviceAuthorityRoute.includes("require('../access/admin-customer-access-control')")
    && serviceAuthorityRoute.includes('adminAccessControl.clearAutomationProtection(')
    && !serviceAuthorityRoute.includes('SET automation_protected=FALSE'),
  'return-to-automation route must delegate customer protection persistence to the access domain');
assert(accessControlOwner.includes('async function clearAutomationProtection')
    && accessControlOwner.includes('UPDATE customers')
    && accessControlOwner.includes('automation_protected=FALSE'),
  'access domain must own automation-protection reset persistence');



const adminProfileRoute=fs.readFileSync(path.join(root,'src/platform/admin-profile-account.js'),'utf8');
const adminProfileSecurity=fs.readFileSync(path.join(root,'src/security/admin-profile-account.js'),'utf8');
const adminLinkedProfile=fs.readFileSync(path.join(root,'src/customers/admin-linked-profile.js'),'utf8');
assert(adminProfileRoute.includes("require('../security/admin-profile-account')")
    && adminProfileRoute.includes("require('../customers/admin-personal-media-profile')")
    && !adminProfileRoute.includes('UPDATE app_users')
    && !adminProfileRoute.includes('UPDATE customers')
    && !adminProfileRoute.includes('INSERT INTO customers')
    && !adminProfileRoute.includes('INSERT INTO subscriptions'),
  'admin profile route must delegate identity, customer and entitlement persistence');
assert(adminProfileSecurity.includes('async function updateAdminEmail')
    && adminProfileSecurity.includes('UPDATE app_users')
    && adminProfileSecurity.includes('linkedProfile.syncLinkedEmailTx'),
  'security domain must own administrator identity email persistence');
assert(adminLinkedProfile.includes('UPDATE customers')
    && adminLinkedProfile.includes('INSERT INTO customers')
    && adminLinkedProfile.includes('manualSubscriptions.createManualSubscriptionTx'),
  'customer profile owner must own linked customer persistence and delegate subscription creation to entitlements');



const adminActionsRoute=fs.readFileSync(path.join(root,'src/platform/admin-actions.js'),'utf8');
const adminCustomerCreation=fs.readFileSync(path.join(root,'src/customers/admin-customer-creation.js'),'utf8');
const customerAccountProvisioning=fs.readFileSync(path.join(root,'src/security/customer-account-provisioning.js'),'utf8');
assert(adminActionsRoute.includes("require('../customers/admin-customer-creation')")
    && adminActionsRoute.includes('adminCustomerCreation.create({')
    && adminActionsRoute.includes('adminCustomerCreation.setActivationDeadline(')
    && !adminActionsRoute.includes('INSERT INTO app_users')
    && !adminActionsRoute.includes('INSERT INTO customers')
    && !adminActionsRoute.includes('INSERT INTO subscriptions')
    && !adminActionsRoute.includes('UPDATE customers SET activation_deadline'),
  'admin customer creation route must delegate business persistence to domain owners');
assert(customerAccountProvisioning.includes('INSERT INTO app_users')
    && customerAccountProvisioning.includes("role,active,email_verified_at"),
  'security domain must own pending customer login creation');
assert(adminCustomerCreation.includes('INSERT INTO customers')
    && adminCustomerCreation.includes('manualSubscriptions.createManualSubscriptionTx')
    && adminCustomerCreation.includes('UPDATE customers SET activation_deadline'),
  'customer domain must own customer record/activation state and delegate entitlement creation');

const adminCustomerManagementRoute=fs.readFileSync(path.join(root,'src/platform/admin-customer-management.js'),'utf8');
const adminCustomerManagementOwner=fs.readFileSync(path.join(root,'src/customers/admin-customer-management-commands.js'),'utf8');
assert(adminCustomerManagementRoute.includes("require('../customers/admin-customer-management-commands')")
    && !adminCustomerManagementRoute.includes('INSERT INTO app_users')
    && !adminCustomerManagementRoute.includes('UPDATE app_users')
    && !adminCustomerManagementRoute.includes('UPDATE customers'),
  'admin customer management route must delegate customer/login mutations');
for(const required of [
  'async function enrolPortal',
  'async function updateAccount',
  'async function setEmailVerified',
  'async function setActivationDeadline',
  'async function setPortalStatus',
  'INSERT INTO app_users',
  'UPDATE app_users',
  'UPDATE customers'
]){
  assert(adminCustomerManagementOwner.includes(required),
    `customer management command owner must retain ${required}`);
}

const portalCredentialRoute=fs.readFileSync(path.join(root,'src/platform/portal-credential-confirmation.js'),'utf8');
const portalCredentialOwner=fs.readFileSync(path.join(root,'src/security/portal-credential-commands.js'),'utf8');
assert(portalCredentialRoute.includes("require('../security/portal-credential-commands')")
    && !portalCredentialRoute.includes('UPDATE app_users')
    && !portalCredentialRoute.includes('UPDATE customers'),
  'portal credential route must delegate customer/login persistence to security commands');
for(const required of [
  'async function stagePasswordChange',
  'async function completePasswordChange',
  'async function stageEmailChange',
  'async function approveOldEmail',
  'async function completeNewEmail',
  'UPDATE app_users',
  'UPDATE customers',
  'UPDATE account_tokens',
  'UPDATE auth_sessions'
]){
  assert(portalCredentialOwner.includes(required),
    `portal credential security owner must retain ${required}`);
}

console.log(`platform business SQL boundary: ok (${observed.length} frozen legacy file/table exceptions; no new direct mutations)`);
