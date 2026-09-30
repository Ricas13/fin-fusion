'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const accessState = require('../src/access/customer-access-state');
const lifecycle = read('src/payments/lifecycle.js');
const dashboard = read('src/platform/customer-dashboard.js');
const myAccess = read('src/platform/customer-jellyfin.js');
const readiness = read('src/jellyfin/free-claim-readiness.js');
const jobs = read('src/jellyfin/jobs.js');
const backfill = read('src/automation/free-capacity-backfill.js');

for (const state of [
  'NONE',
  'ACTIVE_READY',
  'ACTIVE_BLOCKED',
  'PAID_PROVISIONING_FAILED',
  'INCONSISTENT_UNPAID',
  'ORPHAN_ACCOUNT'
]) {
  assert.strictEqual(accessState.ACCESS_STATES[state], state, `canonical access state must expose ${state}`);
}

assert.strictEqual(
  accessState.accountMatchesEntitlement(
    { access_lane: 'free', disabled: false, server_enabled: true, server_class: 'free', server_id: 'server-a' },
    { server_class: 'free' },
    'free'
  ),
  true,
  'ready account matching must accept the correct enabled lane and placement'
);
assert.strictEqual(
  accessState.accountMatchesEntitlement(
    { access_lane: 'free', disabled: true, server_enabled: true, server_class: 'free', server_id: 'server-a' },
    { server_class: 'free' },
    'free'
  ),
  false,
  'disabled accounts must never be canonical ready access'
);
assert.strictEqual(
  accessState.accountMatchesEntitlement(
    { access_lane: 'primary', disabled: false, server_enabled: true, server_class: 'premium', server_id: 'server-a' },
    { server_class: 'premium', admin_forced_server_id: 'server-b' },
    'primary'
  ),
  false,
  'forced placement must override server-class matching'
);
assert.strictEqual(accessState.isTrial({ billing_interval: 'trial', price_minor: 0 }), true);
assert.strictEqual(accessState.isPaid({ billing_interval: 'month', price_minor: 999 }), true);
assert.strictEqual(accessState.isPaid({ billing_interval: 'trial', price_minor: 999 }), false);

for (const [name, source] of [
  ['lifecycle', lifecycle],
  ['customer dashboard', dashboard],
  ['My Access', myAccess],
  ['Free claim readiness', readiness],
  ['entitlement jobs', jobs],
  ['Free capacity repair', backfill]
]) {
  assert(
    source.includes("customer-access-state"),
    `${name} must consume canonical customer access state instead of rebuilding access truth`
  );
}

assert(
  !dashboard.includes("SELECT 1 FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin' AND ja.access_lane='free'"),
  'customer dashboard must not duplicate the canonical Free-ready SQL'
);
assert(
  !readiness.includes('FROM jellyfin_accounts'),
  'Free claim readiness must delegate to canonical access state'
);

console.log('customer access state smoke: ok');
