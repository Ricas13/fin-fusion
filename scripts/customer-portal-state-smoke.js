'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const accessState = require('../src/access/customer-access-state');
const portalState = require('../src/customers/customer-portal-state');
const customerNav = require('../src/platform/customer-nav-html');
const dashboard = require('../src/platform/customer-dashboard');

const extensionEntitlement = {
  subscription_id: 'extended-primary',
  plan_id: 'premium',
  status: 'expired',
  current_period_end: '2026-09-30T00:00:00.000Z',
  service_extension_days: 14,
  access_expires_at: '2026-10-14T00:00:00.000Z',
  service_type: 'jellyfin',
  is_free_tier: false
};
const freeEntitlement = {
  subscription_id: 'free-lane',
  plan_id: 'free',
  status: 'active',
  service_type: 'jellyfin',
  is_free_tier: true
};
const blockedStremio = {
  subscription_id: 'stremio-blocked',
  plan_id: 'stremio',
  status: 'active',
  service_type: 'stremio',
  blocked: true
};
const embyEntitlement = {
  subscription_id: 'emby-current',
  plan_id: 'emby',
  status: 'active',
  service_type: 'emby'
};

const snapshot = {
  primary: { state: accessState.ACCESS_STATES.ACTIVE_READY, entitlement: extensionEntitlement },
  free: { state: accessState.ACCESS_STATES.ACTIVE_READY, entitlement: freeEntitlement },
  stremio: { state: accessState.ACCESS_STATES.ACTIVE_BLOCKED, entitlement: blockedStremio },
  emby: { state: accessState.ACCESS_STATES.ACTIVE_ENTITLED, entitlement: embyEntitlement }
};

const addonEntitlement = {
  subscription_id: 'stremio-addon',
  plan_id: 'stremio-addon-plan',
  status: 'active',
  service_type: 'stremio',
  is_addon: true
};
const subscriptions = portalState.subscriptionsFromAccessSnapshot(snapshot, [addonEntitlement]);
assert.deepStrictEqual(
  subscriptions.map(row => row.subscription_id),
  ['free-lane', 'extended-primary', 'stremio-blocked', 'emby-current', 'stremio-addon'],
  'current portal subscriptions must come directly from canonical lane entitlements plus canonical live add-ons'
);
assert(
  subscriptions.some(row => row.subscription_id === 'extended-primary' && row.status === 'expired'),
  'portal projection must preserve an extension-backed entitlement even when its raw subscription status is expired'
);
assert.strictEqual(portalState.hasCurrentServiceAccess(snapshot), true);

const portal = { subscriptions, accessSnapshot: snapshot, referralsEnabled: true };
const nav = customerNav.optionsFromPortal(portal);
assert.strictEqual(nav.showAccess, true, 'navigation must expose My Access from canonical current service state');
assert.strictEqual(nav.showJellyfin, true, 'navigation must expose Jellyfin access from canonical primary/free lanes');
assert.strictEqual(nav.showBenefits, true, 'Affiliate navigation depends on programme availability, not eager referral-code creation');

const addonOnlyPortal = {
  subscriptions: [addonEntitlement],
  accessSnapshot: {
    primary: { entitlement: null },
    free: { entitlement: null },
    stremio: { entitlement: null },
    emby: { entitlement: null }
  },
  referralsEnabled: false
};
assert.strictEqual(
  portalState.hasCurrentServiceAccess(addonOnlyPortal.accessSnapshot, addonOnlyPortal.subscriptions),
  true,
  'canonical portal service-access flags must count a current streaming-service add-on'
);
const addonOnlyNav = customerNav.optionsFromPortal(addonOnlyPortal);
assert.strictEqual(addonOnlyNav.showAccess, true, 'a canonical service add-on must keep My Access visible even without a primary service lane');
assert.strictEqual(addonOnlyNav.showServicePasswords, false, 'a service add-on alone must not invent non-add-on request access');

const homeRows = dashboard.canonicalAccessRows(portal, {
  currentPlan: extensionEntitlement,
  freePlan: freeEntitlement,
  stremioPlan: null,
  embyPlan: embyEntitlement
});
assert(
  subscriptions.some(row => row.subscription_id === 'stremio-addon'),
  'My Access projection must retain canonical current service add-ons'
);
assert(
  !homeRows.some(row => row.subscription_id === 'stremio-addon'),
  'Account Home must not promote add-ons as separate service lanes'
);
assert(
  homeRows.some(row => row.subscription_id === 'extended-primary'),
  'Account Home must keep canonical extension-backed access without rechecking raw status/current_period_end'
);
assert(
  !homeRows.some(row => row.subscription_id === 'stremio-blocked'),
  'Account Home active-access rows must not leak a blocked lane retained in the full canonical portal projection'
);

const dashboardSource = read('src/platform/customer-dashboard.js');
const dashboardView = read('views/customer/dashboard.ejs');
const accessSource = read('src/platform/customer-jellyfin.js');
const navSource = read('src/platform/customer-nav-html.js');
const customerSource = read('src/customers.js');
const projectionSource = read('src/customers/customer-portal-state.js');

assert(
  dashboardSource.includes('customers.getCurrentCustomerPortal(customerId)')
    && dashboardSource.includes('const accessSnapshot=portal.accessSnapshot'),
  'Account Home must consume the canonical portal projection and its shared access snapshot'
);
assert(
  !dashboardSource.includes('function liveSubscription(')
    && !dashboardSource.includes('customerAccessState.snapshot(customerId,{includeBlocked:')
    && !dashboardSource.includes('portal.subscriptions=accessRows'),
  'Account Home route must not maintain, reload or overwrite the canonical current-subscription projection'
);
assert(
  !dashboardView.includes('function isLive(')
    && dashboardSource.includes('currentAccessRows:accessRows')
    && dashboardView.includes("typeof currentAccessRows!=='undefined'&&Array.isArray(currentAccessRows)")
    && dashboardView.includes('entitlementEnd(s)'),
  'Account Home rendering must trust canonical current subscriptions and use canonical access expiry rather than raw status/current-period filtering'
);
assert(
  accessSource.includes('customers.getCurrentCustomerPortal(customerId)')
    && accessSource.includes('incompleteFreeSubscriptionIdFromState(portal.accessSnapshot?.free)')
    && !accessSource.includes('.filter(customerNav.liveServiceSubscription)'),
  'My Access must consume canonical portal subscriptions instead of filtering raw subscription history'
);
assert(
  navSource.includes('canonicalAccessFlags(portal)')
    && navSource.includes('customers.getCurrentCustomerPortal(customerId)'),
  'customer navigation must prefer canonical portal access state'
);
assert(
  customerSource.includes('getCurrentCustomerPortal')
    && projectionSource.includes('customerAccessState.snapshot(customerId')
    && projectionSource.includes('accounts: jellyfinAccounts'),
  'the customer facade must expose one lean current portal projection that reuses its loaded account rows'
);

console.log('customer portal canonical state smoke: ok');
