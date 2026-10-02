'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function rel(file) {
  return path.relative(root, file).replace(/\\/g, '/');
}

function source(file) {
  return fs.readFileSync(file, 'utf8');
}

const protectedDirs = [
  path.join(root, 'src', 'platform'),
  path.join(root, 'src', 'access'),
  path.join(root, 'src', 'entitlements'),
  path.join(root, 'src', 'automation')
];

const protectedFiles = protectedDirs.flatMap(walk);
const forbiddenFragments = [
  "require('stripe')",
  "require('../payments/provider-http')",
  "require('../payments/provider-lifecycle-adapters')",
  "require('../payments/provider-refund-adapters')",
  '/v1/billing/subscriptions/',
  '/v1/oauth2/token',
  '/v2/payments/refunds/',
  '/v2/payments/captures/'
];

const violations = [];
for (const file of protectedFiles) {
  const text = source(file);
  for (const fragment of forbiddenFragments) {
    if (text.includes(fragment)) violations.push({ file: rel(file), fragment });
  }
}

assert.deepStrictEqual(
  violations,
  [],
  'platform/access/entitlement/automation code must not own provider SDK or HTTP transport; use payments provider contracts/commands'
);

const contract = source(path.join(root, 'src/payments/provider-contract.js'));
assert(contract.includes("require('./provider-lifecycle-adapters')")
  && contract.includes("require('./provider-refund-adapters')")
  && contract.includes('function capabilities(provider)')
  && contract.includes('async function recurring(provider)')
  && contract.includes('function refunds(provider)'),
  'provider-contract must remain the capability boundary over lifecycle and refund adapters');

const billing = source(path.join(root, 'src/payments/billing-control.js'));
assert(billing.includes("require('./provider-contract')")
  && billing.includes('providerContract.recurring('),
  'billing control must consume recurring provider capability through provider-contract');

console.log('provider boundary smoke: ok');
