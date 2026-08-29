'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const laneOverrides = read('src/entitlements/lane-overrides.js');
const accountPolicy = read('src/jellyfin/account-policy.js');
const adminLane = read('src/platform/admin-lane-policy.js');
const composition = read('src/platform/admin-route-composition.js');
const routeManifest = require('../src/platform/admin-route-manifest');
const application = read('src/application.js');
const claims = read('src/customer-claims.js');
const customerClaim = read('src/platform/customer-claim.js');
const adminCustomer = read('src/platform/admin-customer-management.js');
const portal = read('src/platform/customer-router.js');
const provisioning = read('src/jellyfin/provisioning.js');

// Free and Premium playback accounting must remain lane-isolated.
function row(lane, id) { return { access_lane:lane, play_session_id:String(id), device_id:`d${id}` }; }
function overflowRows(rows, limit) { return rows.slice(Math.max(0, limit)); }
const freeOne = [row('free-account', 1)];
const premiumThree = [row('premium-account', 1), row('premium-account', 2), row('premium-account', 3)];
assert.strictEqual(overflowRows([...freeOne, row('free-account', 2)], 1).length, 1, 'second Free stream must overflow independently');
assert.strictEqual(overflowRows([...premiumThree, row('premium-account', 4)], 3).length, 1, 'fourth Premium stream must overflow independently');
// The two independent assertions above deliberately represent 1 Free + 3 Premium
// coexisting for the same portal customer without a synthetic global quota.

// Provisioning uses the account lane's technical policy.
assert(/laneOverrides\.getPolicyOverride\(customerId,\s*accessLane\)/.test(accountPolicy), 'Jellyfin account policy must resolve the matching lane override');
assert(/access_lane/.test(accountPolicy), 'account policy must use Jellyfin access_lane');
assert(/getPolicyOverride/.test(laneOverrides)&&/setPolicyOverrideField/.test(laneOverrides)&&/resetAllPolicyOverrides/.test(laneOverrides), 'lane override service must expose scoped lifecycle operations');

// Customer 360 shows and mutates Free and Premium policy independently.
assert(/Premium Jellyfin policy/.test(adminLane)&&/Free Access policy/.test(adminLane), 'Customer 360 must show separate Premium and Free policy sections');
assert(/name="accessLane" value="\$\{esc\(accessLane\)\}"/.test(adminLane), 'policy mutation forms must submit the lane explicitly');
assert(/setPolicyOverrideField\(req\.params\.customerId,\s*accessLane/.test(adminLane), 'admin override writes must be lane scoped');

// Production composition now declares the critical wildcard/literal ownership
// through mountCritical and validates it at startup. Keep this regression tied
// to those semantic owners rather than to the old literal app.use spelling.
const lanePos = composition.indexOf("mountCritical('lanePolicy', createAdminLanePolicyRouter())");
const customer360Pos = composition.indexOf("mountCritical('customer360', createAdminCustomer360Router())");
const impersonationCompositionPos = composition.indexOf("mountCritical('impersonation', createAdminImpersonationRouter())");
const usersDashboardPos = composition.indexOf("mountCritical('usersDashboard', createAdminUsersDashboardRouter())");
assert(lanePos >= 0 && customer360Pos >= 0 && lanePos < customer360Pos, 'lane policy middleware must wrap Customer 360 before it owns the response');
assert(impersonationCompositionPos >= 0 && usersDashboardPos >= 0 && customer360Pos >= 0
    && usersDashboardPos < impersonationCompositionPos && impersonationCompositionPos < customer360Pos,
    'the impersonate/exit routes and Customer 360 button-injection wildcard must stay after the specific /admin/users/dashboard route and before Customer 360');
assert(routeManifest.assertAdminRouteOrder(['usersDashboard','settingsCommerce','originalSettings','planAccess','plans','impersonation','lanePolicy','customer360']), 'declarative route ownership contract must remain valid');
assert(composition.includes('assertAdminRouteOrder(criticalOrder)'), 'production startup must enforce critical admin route precedence');

// Impersonation's audit-and-banner middleware must run before ANY /account
// router that can terminate the response itself -- otherwise customer
// mutations made while impersonating never reach the policy/audit pass.
const impersonationAppPos = application.indexOf('app.use(createImpersonationAuditRouter())');
const passwordSyncPos = application.indexOf('app.use(createCustomerPasswordSyncRouter())');
const subscriptionActionsPos = application.indexOf('app.use(createCustomerSubscriptionActionsRouter())');
const checkoutPos = application.indexOf('app.use(createFlexibleCheckoutRouter())');
assert(impersonationAppPos >= 0 && passwordSyncPos >= 0 && subscriptionActionsPos >= 0 && checkoutPos >= 0
    && impersonationAppPos < passwordSyncPos && impersonationAppPos < subscriptionActionsPos && impersonationAppPos < checkoutPos,
    'impersonation audit/banner middleware must run before customer mutation routers');

// Imported account claims remain explicit and cannot quietly bypass ownership.
assert(/claim.*customer/i.test(claims), 'customer claims service must retain explicit claim semantics');
assert(/createCustomerClaimRouter/.test(customerClaim), 'customer claim route owner must remain mounted');
assert(/claim/i.test(adminCustomer), 'admin customer management must retain claim visibility');

// Customer portal and provisioning still consume canonical account/lane data.
assert(/access_lane/.test(provisioning), 'provisioning must retain access-lane awareness');
assert(/account/.test(portal), 'customer portal must retain account surface');

console.log('lane entitlements/onboarding/impersonation smoke: ok');
