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
  'src/platform/admin-actions.js::subscriptions',
  'src/platform/admin-actions.js::customers',
  'src/platform/admin-actions.js::app_users',
  'src/platform/admin-customer-management.js::customers',
  'src/platform/admin-customer-management.js::app_users',
  'src/platform/admin-media-controls.js::plans',
  'src/platform/admin-service-authority.js::customers',
  'src/platform/portal-credential-confirmation.js::customers',
  'src/platform/portal-credential-confirmation.js::app_users',
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

console.log(`platform business SQL boundary: ok (${observed.length} frozen legacy file/table exceptions; no new direct mutations)`);
