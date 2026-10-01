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
const accessRepair = read('src/access/access-repair.js');

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

const freeAccount = {
  id: 'free-ready',
  access_lane: 'free',
  disabled: false,
  server_enabled: true,
  server_class: 'free',
  server_id: 'free-a'
};
const primaryAccount = {
  id: 'primary-ready',
  access_lane: 'primary',
  disabled: false,
  server_enabled: true,
  server_class: 'premium',
  server_id: 'premium-a'
};

assert.strictEqual(
  accessState.classifyLane({ entitlement: null, accounts: [], lane: 'free' }).state,
  accessState.ACCESS_STATES.NONE,
  'no entitlement and no lane account must be NONE'
);
assert.strictEqual(
  accessState.classifyLane({ entitlement: null, accounts: [freeAccount], lane: 'free' }).state,
  accessState.ACCESS_STATES.ORPHAN_ACCOUNT,
  'a lane account without entitlement must be ORPHAN_ACCOUNT'
);
assert.strictEqual(
  accessState.classifyLane({
    entitlement: { blocked: true, server_class: 'free' },
    accounts: [freeAccount],
    lane: 'free'
  }).state,
  accessState.ACCESS_STATES.ACTIVE_BLOCKED,
  'blocked entitlement must remain ACTIVE_BLOCKED even when an account exists'
);
assert.strictEqual(
  accessState.classifyLane({
    entitlement: { server_class: 'free', price_minor: 0, billing_interval: 'month' },
    accounts: [],
    lane: 'free'
  }).state,
  accessState.ACCESS_STATES.INCONSISTENT_UNPAID,
  'Free entitlement without a ready account must be INCONSISTENT_UNPAID'
);
assert.strictEqual(
  accessState.classifyLane({
    entitlement: { server_class: 'premium', price_minor: 0, billing_interval: 'trial' },
    accounts: [],
    lane: 'primary',
    paidMissing: true
  }).state,
  accessState.ACCESS_STATES.INCONSISTENT_UNPAID,
  'unpaid trial without a ready account must be INCONSISTENT_UNPAID'
);
assert.strictEqual(
  accessState.classifyLane({
    entitlement: { server_class: 'premium', price_minor: 999, billing_interval: 'month' },
    accounts: [],
    lane: 'primary',
    paidMissing: true
  }).state,
  accessState.ACCESS_STATES.PAID_PROVISIONING_FAILED,
  'committed paid access without a ready account must retain entitlement as PAID_PROVISIONING_FAILED'
);
assert.strictEqual(
  accessState.classifyLane({
    entitlement: { server_class: 'premium', price_minor: 999, billing_interval: 'month' },
    accounts: [primaryAccount],
    lane: 'primary',
    paidMissing: true
  }).state,
  accessState.ACCESS_STATES.ACTIVE_READY,
  'matching enabled account must classify as ACTIVE_READY'
);
assert.strictEqual(
  accessState.classifyLane({
    entitlement: { server_class: 'premium', price_minor: 999, billing_interval: 'month' },
    accounts: [freeAccount],
    lane: 'primary',
    paidMissing: true
  }).state,
  accessState.ACCESS_STATES.PAID_PROVISIONING_FAILED,
  'an account from the wrong access lane must not satisfy paid readiness'
);

for (const [name, source] of [
  ['lifecycle', lifecycle],
  ['customer dashboard', dashboard],
  ['My Access', myAccess],
  ['Free claim readiness', readiness],
  ['access repair', accessRepair]
]) {
  assert(
    source.includes("customer-access-state"),
    `${name} must consume canonical customer access state instead of rebuilding access truth`
  );
}
assert(jobs.includes("require('../access/access-repair')"),
  'entitlement jobs must delegate repair decisions to the canonical access repair layer');
assert(backfill.includes("require('../access/access-repair')"),
  'Free capacity repair must delegate repair decisions to the canonical access repair layer');

assert(
  !dashboard.includes("SELECT 1 FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin' AND ja.access_lane='free'"),
  'customer dashboard must not duplicate the canonical Free-ready SQL'
);
assert(
  !readiness.includes('FROM jellyfin_accounts'),
  'Free claim readiness must delegate to canonical access state'
);

assert(
  myAccess.includes("customerAccessState.freeJellyfin(customerId,{includeBlocked:true})"),
  'My Access must use canonical Free access readiness instead of issuing its own Free account readiness query'
);
assert(
  !myAccess.includes("AND ja.access_lane='free'\n            AND ja.disabled=FALSE\n            AND js.enabled=TRUE"),
  'My Access must not rebuild canonical Free-ready SQL'
);

console.log('customer access state smoke: ok');
