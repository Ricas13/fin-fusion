'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const fixture = require('../test-fixture');

const root = path.join(__dirname, '..', '..');

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

test('shared fixture layer exposes scoped helpers', async () => {
  for (const name of [
    'runDbSmoke','withRollback','withTimezones','withEnv','unique','deferred','barrier',
    'installModuleMock','fixtureCustomer','fixturePlan','fixtureSubscription'
  ]) assert.equal(typeof fixture[name], 'function', `${name} must be exported`);

  const before = process.env.CAPTAINFIN_FIXTURE_TEST;
  await fixture.withEnv({ CAPTAINFIN_FIXTURE_TEST: 'inside' }, async () => {
    assert.equal(process.env.CAPTAINFIN_FIXTURE_TEST, 'inside');
  });
  assert.equal(process.env.CAPTAINFIN_FIXTURE_TEST, before);

  assert.notEqual(fixture.unique('fixture'), fixture.unique('fixture'));

  const wait = fixture.barrier(2);
  let passed = 0;
  await Promise.all([
    wait().then(() => { passed += 1; }),
    wait().then(() => { passed += 1; })
  ]);
  assert.equal(passed, 2);
});

test('platform and access layers cannot own provider transport', () => {
  const protectedDirs = [
    path.join(root, 'src', 'platform'),
    path.join(root, 'src', 'access'),
    path.join(root, 'src', 'entitlements'),
    path.join(root, 'src', 'automation')
  ];
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
  for (const file of protectedDirs.flatMap(walk)) {
    const source = fs.readFileSync(file, 'utf8');
    for (const fragment of forbiddenFragments) {
      if (source.includes(fragment)) {
        violations.push({
          file: path.relative(root, file).replace(/\\/g, '/'),
          fragment
        });
      }
    }
  }
  assert.deepEqual(violations, []);

  const contract = fs.readFileSync(path.join(root, 'src/payments/provider-contract.js'), 'utf8');
  assert.match(contract, /require\('\.\/provider-lifecycle-adapters'\)/);
  assert.match(contract, /require\('\.\/provider-refund-adapters'\)/);
  assert.match(contract, /function capabilities\(provider\)/);
  assert.match(contract, /async function recurring\(provider\)/);
  assert.match(contract, /function refunds\(provider\)/);

  const billing = fs.readFileSync(path.join(root, 'src/payments/billing-control.js'), 'utf8');
  assert.match(billing, /require\('\.\/provider-contract'\)/);
  assert.match(billing, /providerContract\.recurring\(/);
});
