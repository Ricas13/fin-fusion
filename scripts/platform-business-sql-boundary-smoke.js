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
  'src/platform/admin-plan-order.js::plans',
  'src/platform/admin-profile-account.js::subscriptions',
  'src/platform/admin-profile-account.js::customers',
  'src/platform/admin-profile-account.js::app_users',
  'src/platform/admin-request-plan-policy.js::plans',
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

console.log(`platform business SQL boundary: ok (${observed.length} frozen legacy file/table exceptions; no new direct mutations)`);
