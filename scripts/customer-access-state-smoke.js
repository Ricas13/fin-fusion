'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

const accessState = require('../src/access/customer-access-state');
const dashboardModule = require('../src/platform/customer-dashboard');
const customer360Module = require('../src/platform/customer-360');
const lifecycle = read('src/payments/lifecycle.js');
const dashboard = read('src/platform/customer-dashboard.js');
const myAccess = read('src/platform/customer-jellyfin.js');
const customerMediaAccess = read('src/access/customer-media-access.js');
const readiness = read('src/jellyfin/free-claim-readiness.js');
const jobs = read('src/jellyfin/jobs.js');
const backfill = read('src/automation/free-capacity-backfill.js');
const accessRepair = read('src/access/access-repair.js');
const customer360 = read('src/platform/customer-360.js');
const customer360Truth = read('src/platform/customer-360-service-truth.js');

for (const state of [
  'NONE',
  'ACTIVE_READY',
  'ACTIVE_BLOCKED',
  'PAID_PROVISIONING_FAILED',
  'INCONSISTENT_UNPAID',
  'ORPHAN_ACCOUNT',
  'ACTIVE_ENTITLED'
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
assert.strictEqual(accessState.operatorProtected({ permanent_access: true }), true,
  'Permanent Access must protect an entitlement from automatic destructive repair');
assert.strictEqual(accessState.operatorProtected({ admin_jellyfin_mode: 'present' }), true,
  'explicit administrator-present authority must protect an entitlement from automatic destructive repair');
assert.strictEqual(accessState.operatorProtected({ admin_present: true }), true,
  'raw administrator-present state must be recognized before decoration');
assert.strictEqual(accessState.operatorProtected({ admin_jellyfin_mode: 'forced_server' }), false,
  'server pin is placement-only and must not disable lifecycle enforcement');
assert.strictEqual(accessState.operatorProtected({ admin_present: true, admin_jellyfin_mode: 'forced_server' }), false,
  'a legacy/raw admin-present compatibility flag must not override an explicit placement-only server pin');
assert.strictEqual(accessState.operatorProtected(null), false,
  'missing entitlements are never operator-protected');

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
  ['customer media access domain', customerMediaAccess],
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
assert(customer360.includes("require('../access/customer-access-state')")
  && customer360.includes('customerAccessState.snapshot(customerId)')
  && !customer360.includes("require('../jellyfin/resilient-provisioning')")
  && !customer360.includes('currentEntitlementTruth(customerId)'),
  'Customer 360 must load one canonical cross-service access snapshot without a parallel current-entitlement reader');
assert(dashboard.includes('customers.getCurrentCustomerPortal(customerId)')
  && dashboard.includes('const accessSnapshot=portal.accessSnapshot')
  && dashboard.includes('primaryAccess=accessSnapshot.primary')
  && dashboard.includes('freeAccess=accessSnapshot.free')
  && dashboard.includes('stremioAccess=accessSnapshot.stremio')
  && dashboard.includes('embyAccess=accessSnapshot.emby'),
  'Account Home must derive all current service lanes from the canonical customer portal projection');
assert(customer360Truth.includes('canonical.emby?.entitlement')
  && customer360Truth.includes('canonical.stremio?.entitlement'),
  'Customer 360 service truth must consume canonical Emby/Stremio entitlement selection instead of re-deciding it');

const sharedSnapshotFixture={
  primary:{state:accessState.ACCESS_STATES.ACTIVE_READY,entitlement:{subscription_id:'paid-shared',is_free_tier:false}},
  free:{state:accessState.ACCESS_STATES.ACTIVE_READY,entitlement:{subscription_id:'free-shared',is_free_tier:true}},
  stremio:{state:accessState.ACCESS_STATES.ACTIVE_ENTITLED,entitlement:{subscription_id:'stremio-shared'}},
  emby:{state:accessState.ACCESS_STATES.ACTIVE_ENTITLED,entitlement:{subscription_id:'emby-shared'}}
};
const homeProjection=dashboardModule.plansFromAccessSnapshot(sharedSnapshotFixture);
assert.strictEqual(homeProjection.currentPlan,sharedSnapshotFixture.primary.entitlement,
  'Account Home must project primary access from the shared canonical fixture');
assert.strictEqual(homeProjection.freePlan,sharedSnapshotFixture.free.entitlement,
  'Account Home must project Free access from the shared canonical fixture');
assert.strictEqual(customer360Module.primaryEntitlementFromAccessState(sharedSnapshotFixture),sharedSnapshotFixture.primary.entitlement,
  'Customer 360 must resolve the same primary entitlement from the shared canonical fixture');
assert(!customerMediaAccess.includes("require('../entitlements/subscription-state')"),
  'customer media access domain must not maintain a separate Emby entitlement lookup');
assert(customerMediaAccess.includes('accessSnapshot?.emby?.entitlement'),
  'customer media access must obtain Emby entitlement from the canonical access snapshot');

assert(
  !dashboard.includes("SELECT 1 FROM jellyfin_accounts ja JOIN jellyfin_servers js ON js.id=ja.server_id WHERE ja.customer_id=$1 AND ja.account_purpose='jellyfin' AND ja.access_lane='free'"),
  'customer dashboard must not duplicate the canonical Free-ready SQL'
);
assert(
  !readiness.includes('FROM jellyfin_accounts'),
  'Free claim readiness must delegate to canonical access state'
);

assert(
  customerMediaAccess.includes("customerAccessState.freeJellyfin(customerId, { includeBlocked: true })"),
  'customer media access domain must use canonical Free access readiness'
);
assert(
  myAccess.includes("require('../access/customer-media-access')"),
  'My Access route must consume the customer media access domain service'
);
assert(
  !myAccess.includes("require('../access/customer-access-state')")
    && !myAccess.includes("require('../entitlements/subscription-state')"),
  'My Access route must not independently interpret canonical subscription/access state'
);
assert(
  !myAccess.includes('FROM jellyfin_accounts'),
  'My Access route must not own customer media account/server SQL'
);
assert(
  myAccess.includes('customerMediaAccess.incompleteFreeSubscriptionIdFromState(portal.accessSnapshot?.free)'),
  'My Access must reuse the canonical portal snapshot for incomplete Free-state interpretation'
);

const freeIncomplete = accessState.ACCESS_STATES.INCONSISTENT_UNPAID;
const mediaAccess = require('../src/access/customer-media-access');
assert.strictEqual(
  mediaAccess.entitlementForAccountFromContext(
    { media_server_type:'jellyfin', access_lane:'primary' },
    { accessSnapshot:sharedSnapshotFixture }
  ),
  sharedSnapshotFixture.primary.entitlement,
  'My Access must resolve the same primary entitlement from the shared canonical fixture'
);
assert.strictEqual(
  mediaAccess.entitlementForAccountFromContext(
    { media_server_type:'jellyfin', access_lane:'free' },
    { accessSnapshot:sharedSnapshotFixture }
  ),
  sharedSnapshotFixture.free.entitlement,
  'My Access must resolve the same Free entitlement from the shared canonical fixture'
);
assert.strictEqual(
  mediaAccess.incompleteFreeSubscriptionIdFromState({
    state: freeIncomplete,
    entitlement: { subscription_id: 'free-incomplete', blocked: false }
  }),
  'free-incomplete',
  'incomplete unblocked Free entitlement must remain identifiable for safe portal suppression'
);
assert.strictEqual(
  mediaAccess.incompleteFreeSubscriptionIdFromState({
    state: accessState.ACCESS_STATES.ACTIVE_READY,
    entitlement: { subscription_id: 'free-ready', blocked: false }
  }),
  null,
  'ready Free access must never be treated as incomplete'
);
assert.strictEqual(
  mediaAccess.incompleteFreeSubscriptionIdFromState({
    state: accessState.ACCESS_STATES.ACTIVE_BLOCKED,
    entitlement: { subscription_id: 'free-blocked', blocked: true }
  }),
  null,
  'blocked Free access must not be reinterpreted as incomplete provisioning'
);

const context = {
  accessSnapshot: {
    free: { entitlement: { subscription_id: 'free-sub', blocked: false } },
    primary: { entitlement: { subscription_id: 'paid-sub', blocked: false } },
    emby: { entitlement: { subscription_id: 'emby-sub', blocked: false } }
  }
};
assert.strictEqual(
  mediaAccess.entitlementForAccountFromContext({ media_server_type: 'jellyfin', access_lane: 'free' }, context).subscription_id,
  'free-sub',
  'Free account credential decisions must use only the Free entitlement lane'
);
assert.strictEqual(
  mediaAccess.entitlementForAccountFromContext({ media_server_type: 'jellyfin', access_lane: 'primary' }, context).subscription_id,
  'paid-sub',
  'Premium account credential decisions must use only the primary entitlement lane'
);
assert.strictEqual(
  mediaAccess.entitlementForAccountFromContext({ media_server_type: 'emby', access_lane: 'primary' }, context).subscription_id,
  'emby-sub',
  'Emby account credential decisions must remain isolated from Jellyfin lanes'
);
assert.strictEqual(
  mediaAccess.evaluateCredentialAccess(null, null).reason,
  'not_found',
  'credential authorization must reject unknown accounts'
);
assert.strictEqual(
  mediaAccess.evaluateCredentialAccess({ disabled: true, server_enabled: true }, context.accessSnapshot.primary.entitlement).reason,
  'account_unavailable',
  'disabled media accounts must not be authorized for credential changes'
);
assert.strictEqual(
  mediaAccess.evaluateCredentialAccess({ disabled: false, server_enabled: false }, context.accessSnapshot.primary.entitlement).reason,
  'account_unavailable',
  'accounts on disabled servers must not be authorized for credential changes'
);
assert.strictEqual(
  mediaAccess.evaluateCredentialAccess({ disabled: false, server_enabled: true }, { blocked: true }).reason,
  'entitlement_unavailable',
  'blocked entitlements must not authorize credential changes'
);
assert.strictEqual(
  mediaAccess.evaluateCredentialAccess({ disabled: false, server_enabled: true }, context.accessSnapshot.primary.entitlement).ok,
  true,
  'enabled account plus current unblocked entitlement must authorize credential management'
);

Promise.all([
  accessState.preferUnblockedLane(
    true,
    { state: accessState.ACCESS_STATES.ACTIVE_BLOCKED, entitlement: { subscription_id: 'blocked-newer' } },
    async () => ({ state: accessState.ACCESS_STATES.ACTIVE_READY, entitlement: { subscription_id: 'usable-older' } })
  ).then(result => assert.strictEqual(result.entitlement.subscription_id, 'usable-older',
    'blocked-aware snapshots must prefer another usable entitlement in the same lane')),
  accessState.preferUnblockedLane(
    true,
    { state: accessState.ACCESS_STATES.ACTIVE_BLOCKED, entitlement: { subscription_id: 'blocked-only' } },
    async () => ({ state: accessState.ACCESS_STATES.NONE, entitlement: null })
  ).then(result => assert.strictEqual(result.entitlement.subscription_id, 'blocked-only',
    'blocked-aware snapshots must retain blocked state when no usable entitlement exists'))
]).then(() => {
  console.log('customer access state smoke: ok');
}).catch(error => {
  console.error(error);
  process.exit(1);
});
