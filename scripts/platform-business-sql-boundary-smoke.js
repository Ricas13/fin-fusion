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

const violations = [];
for (const file of walk(platformRoot)) {
  const source = fs.readFileSync(file, 'utf8');
  for (const table of domainOwnedTables) {
    const mutation = new RegExp(`\\b(?:INSERT\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(?:public\\.)?${table}\\b`, 'i');
    if (mutation.test(source)) violations.push({ file: relative(file), table });
  }
}

assert.deepStrictEqual(
  violations,
  [],
  `src/platform must not mutate domain-owned business tables directly; move the command behind its domain owner or document a deliberately scoped exception. Violations: ${JSON.stringify(violations)}`
);

console.log('platform business SQL boundary: ok');
