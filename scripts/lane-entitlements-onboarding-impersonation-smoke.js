'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const migration = read('db/migrations/099_lane_scoped_customer_policy.sql');
const activityWorker = read('scripts/activity-worker.js');
const laneStream = read('src/jellyfin/lane-stream-policy.js');
const accountPolicy = read('src/jellyfin/account-library-policy.js');
const laneOverrides = read('src/jellyfin/lane-policy-overrides.js');
const adminLane = read('src/platform/admin-lane-policy.js');
const composition = read('src/platform/admin-route-composition.js');
const application = read('src/application.js');
const customerClaim = read('src/platform/customer-claim.js');
const claims = read('src/customer-claims.js');
const customers = read('src/customers.js');
const security = read('src/platform/customer-security.js');
const impersonation = read('src/platform/admin-impersonation.js');
const planCreateClient = read('public/js/admin-plan-create-v2.js');
const runtimeRoles = read('scripts/configure-runtime-db-roles.js');
const { overflowRows } = require('../src/jellyfin/lane-stream-policy');
const { restrictedImpersonationAction } = require('../src/platform/admin-impersonation');
const { assertAdminRouteOrder } = require('../src/platform/admin-route-manifest');

// Lane-scoped policy storage and migration safety.
assert(/CREATE TABLE IF NOT EXISTS customer_lane_policy_overrides/.test(migration), 'lane policy table migration missing');
assert(/CHECK \(access_lane IN \('primary','free'\)\)/.test(migration), 'lane policy table must restrict access lanes');
assert(/SELECT customer_id,'primary',streams/.test(migration), 'legacy policy overrides must migrate to the primary lane');
assert(!/SELECT customer_id,'free',streams/.test(migration), 'legacy overrides must never be copied to Free Access');
assert(/PRIMARY KEY \(customer_id, access_lane\)/.test(migration), 'lane policy overrides must be unique per customer/lane');
assert(/ALTER TABLE plans ALTER COLUMN allow_audio_transcoding SET DEFAULT FALSE/.test(migration), 'audio-transcode schema default must be conservative');
assert(/ALTER TABLE plans ALTER COLUMN allow_live_tv SET DEFAULT FALSE/.test(migration), 'Live TV schema default must be conservative');
assert(/WHEN is_free_tier=TRUE OR billing_interval='trial' THEN FALSE/.test(migration), 'Free and Trial plans must not gain downloads');
assert(/WHEN price_minor>0 THEN TRUE/.test(migration), 'paid direct Jellyfin plans must retain downloads by default');
assert(/allow_video_transcoding=FALSE/.test(migration)&&/allow_audio_transcoding=FALSE/.test(migration)&&/allow_remuxing=FALSE/.test(migration), 'direct Jellyfin catalogue must default conversion features off');
assert(/allow_live_tv=FALSE/.test(migration)&&/allow_live_tv_management=FALSE/.test(migration), 'direct Jellyfin catalogue must default Live TV off');
assert(/CASE WHEN is_free_tier=TRUE THEN 1 ELSE streams END/.test(migration), 'Free Access must remain one stream');

// Runtime enforcement is account/lane scoped, never customer-wide.
assert(/require\('\.\.\/src\/jellyfin\/lane-stream-policy'\)/.test(activityWorker), 'activity worker must run the lane-aware policy');
assert(/const key = String\(row\.jellyfin_account_id\)/.test(laneStream), 'stream enforcement must group by Jellyfin identity');
assert(/String\(session\.UserId \|\| ''\)\.toLowerCase\(\) === userId/.test(laneStream), 'safety snapshot must revalidate the exact Jellyfin user');
assert(/registry\.request\(row\.server_id/.test(laneStream), 'safety snapshot must stay on the account server');
assert(/customer_lane_policy_overrides/.test(laneStream)&&/access_lane/.test(laneStream), 'stream limiter must read lane-specific overrides');
assert(/commercial_snapshot->>'streams'/.test(laneStream), 'stream limiter must honor the subscription contract stream snapshot');
assert(/LANE_ADVISORY_LOCK_ID/.test(laneStream)&&/pg_try_advisory_lock/.test(laneStream), 'lane enforcement must serialize the full decision phase');
assert(/restoreLaneConfirmations/.test(laneStream), 'legacy observer counters must not contaminate lane confirmations');
assert(!/subscription-state/.test(laneStream), 'restricted activity worker must not pull in broad entitlement helpers');

const base = new Date('2026-08-27T12:00:00Z').getTime();
const row = (account, index) => ({ jellyfin_account_id: account, is_paused: false, first_seen_at: new Date(base + index * 1000).toISOString() });
const freeOne = [row('free-account', 1)];
const premiumThree = [row('premium-account', 1), row('premium-account', 2), row('premium-account', 3)];
assert.strictEqual(overflowRows(freeOne, 1).length, 0, 'one Free stream must be allowed');
assert.strictEqual(overflowRows(premiumThree, 3).length, 0, 'three Premium streams must be allowed');
assert.strictEqual(overflowRows([...freeOne, row('free-account', 2)], 1).length, 1, 'second Free stream must overflow independently');
assert.strictEqual(overflowRows([...premiumThree, row('premium-account', 4)], 3).length, 1, 'fourth Premium stream must overflow independently');
// The two independent assertions above deliberately represent 1 Free + 3 Premium
// coexisting for the same portal customer without a synthetic global quota.

// Provisioning uses the account lane's technical policy.
assert(/laneOverrides\.getPolicyOverride\(customerId,\s*accessLane\)/.test(accountPolicy), 'Jellyfin account policy must resolve the matching lane override');
assert(/access_lane/.test(accountPolicy), 'account policy must use Jellyfin access_lane');
assert(/getPolicyOverride/.test(laneOverrides)&&/setPolicyOverrideField/.test(laneOverrides)&&/resetAllPolicyOverrides/.test(laneOverrides), 'lane override service must expose scoped lifecycle operations');

// Customer 360 shows and mutates Free and Premium policy independently.
// Deliberate reversal: the old full-width "Premium Jellyfin policy"/"Free
// Access policy" tables were replaced by per-lane dense panels rendered by
// customer-360-access-cards.js's laneBlock(), keyed off LANE_LABEL.
const accessCardsSourceForLane = read('src/platform/customer-360-access-cards.js');
assert(/LANE_LABEL=\{primary:'Premium',free:'Free Server'\}/.test(accessCardsSourceForLane), 'Customer 360 must label the Premium and Free Server lanes');
assert(/laneBlock\('primary'/.test(accessCardsSourceForLane)&&/laneBlock\('free'/.test(accessCardsSourceForLane), 'Customer 360 must render a per-lane panel for both the primary and free lanes');
assert(!/lanePanel|laneSections/.test(adminLane), 'the old server-rendered lane policy tables must be removed in favor of the dense per-lane panels');
assert(/name="accessLane" value="\$\{esc\(lane\)\}"/.test(accessCardsSourceForLane), 'policy mutation forms must submit the lane explicitly');
assert(/setPolicyOverrideField\(req\.params\.customerId,\s*accessLane/.test(adminLane), 'admin override writes must be lane scoped');
const lanePos = composition.indexOf("mountCritical('lanePolicy', createAdminLanePolicyRouter())");
const customer360Pos = composition.indexOf("mountCritical('customer360', createAdminCustomer360Router())");
const impersonationCompositionPos = composition.indexOf("mountCritical('impersonation', createAdminImpersonationRouter())");
const usersDashboardPos = composition.indexOf("mountCritical('usersDashboard', createAdminUsersDashboardRouter())");
assert(lanePos >= 0 && customer360Pos >= 0 && lanePos < customer360Pos, 'lane policy middleware must wrap Customer 360 before it owns the response');
assert(impersonationCompositionPos >= 0 && usersDashboardPos >= 0 && customer360Pos >= 0
    && usersDashboardPos < impersonationCompositionPos && impersonationCompositionPos < customer360Pos,
    'the impersonate/exit routes and Customer 360 button-injection wildcard must stay after the specific /admin/users/dashboard route (so they never shadow it) and before Customer 360');
assert(assertAdminRouteOrder(['usersDashboard','settingsCommerce','originalSettings','planAccess','plans','impersonation','lanePolicy','customer360']), 'declarative route ownership contract must remain valid');
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
    'impersonation audit/policy middleware must be mounted before every /account router so it can restrict and observe customer mutations');
assert(!application.includes('createAdminImpersonationRouter'), 'application.js must only mount the path-less impersonation audit router directly, not the one owning /admin/users/:customerId routes');

// Imported-user onboarding can deliberately create an email-less portal identity.
assert(/Email <span class="help">\(optional\)<\/span>/.test(customerClaim), 'imported claim page must present email as optional');
assert(/Optional\. You can sign in with the portal username even without an email/.test(customerClaim), 'email-less login guidance missing from claim page');
assert(/cleanEmail\(email,false\)/.test(claims), 'claim redemption must accept a missing email');
assert(/INSERT INTO app_users\(email,username,password_hash/.test(claims), 'claim redemption must create the portal identity without inventing an email');
assert(/lower\(u\.email\)=lower\(\$1\) OR lower\(u\.username\)=lower\(\$1\)/.test(customers), 'portal login must accept username or email');
assert(/async function changePortalPassword/.test(customers)&&/password_hash/.test(customers), 'portal password change must exist independently of email');
assert(/\/account\/security\/password/.test(security), 'Account Security must expose portal password change');
assert(/customer_no_email_verification_state/.test(migration), 'email-less imported users must not be trapped by the email-verification gate');

// Admin impersonation uses the real portal with a global read-only support policy.
assert(/View portal \(read-only\)/.test(impersonation), 'Customer 360 must label impersonation as a read-only portal view');
assert(/Nested impersonation is not allowed/.test(impersonation), 'nested impersonation must be blocked');
assert(/row\?\.role === 'customer'/.test(impersonation), 'privileged/admin targets must not be impersonable');
assert(/req\.session\.impersonation = \{/.test(impersonation)&&/actorUserId: req\.session\.authUserId/.test(impersonation), 'real admin actor identity must remain attached to impersonation');
assert(/req\.session\.customerId = target\.customer_id/.test(impersonation)&&/return res\.redirect\('\/account'\)/.test(impersonation), 'impersonation must enter the real customer portal');
assert(/Read-only support view: \$\{esc\(label\)\}/.test(impersonation)&&/Exit impersonation/.test(impersonation), 'persistent read-only support banner/exit control missing');
assert(/admin\.impersonation\.start/.test(impersonation)&&/admin\.impersonation\.end/.test(impersonation)&&/admin\.impersonation\.customer_action/.test(impersonation), 'impersonation lifecycle and denied mutations must be audited');
assert(!/password_hash|currentPassword|setJellyfinPassword/.test(impersonation), 'impersonation must never read or bypass customer passwords');
const impersonated=(method,path)=>({session:{impersonation:{id:'test'}},method,path});
for (const path of [
  '/account/checkout/stripe',
  '/account/security/password',
  '/account/jellyfin/account-1/password',
  '/account/requests/password',
  '/account/affiliate/credit-to-service',
  '/account/support/tickets',
  '/account/stremio/install',
  '/account/stremio/reset-household',
  '/account/stremio/revoke'
]) assert.strictEqual(restrictedImpersonationAction(impersonated('POST',path)),'customer changes',`impersonation must block ${path}`);
assert.strictEqual(restrictedImpersonationAction(impersonated('PATCH','/account/profile')),'customer changes','impersonation must block PATCH mutations');
assert.strictEqual(restrictedImpersonationAction(impersonated('DELETE','/account/profile')),'customer changes','impersonation must block DELETE mutations');
assert.strictEqual(restrictedImpersonationAction(impersonated('GET','/account')) ,null,'read-only browsing must remain available');
assert.strictEqual(restrictedImpersonationAction(impersonated('POST','/account/impersonation/exit')),null,'exit must remain available');
assert.strictEqual(restrictedImpersonationAction({session:{},method:'POST',path:'/account/checkout/stripe'}),null,'normal customer sessions must not be affected by impersonation policy');

// New plan UI must not silently re-enable the permissions that triggered this audit.
assert(/setChecked\('allowDownloads',paidRecurring\)/.test(planCreateClient), 'paid recurring plan creator must recommend downloads');
for (const name of ['allowVideoTranscoding','allowAudioTranscoding','allowRemuxing','allowLiveTv','allowLiveTvManagement']) {
    assert(new RegExp(`setChecked\\('${name}',false\\)`).test(planCreateClient), `${name} must default off in plan creator`);
}
assert(/frequency\?\.value!=='trial'/.test(planCreateClient), 'Trial plan creator must keep downloads off');

// Least-privilege activity role has enough data to enforce lanes, but cannot edit policy.
assert(/GRANT SELECT\(customer_id,access_lane,streams\) ON customer_lane_policy_overrides/.test(runtimeRoles), 'activity role must read lane stream overrides');
assert(/GRANT SELECT\(customer_id,subscription_id,permanent_access,revoked_at\) ON customer_entitlement_overrides/.test(runtimeRoles), 'activity role must read only permanent entitlement facts it needs');
assert(!/GRANT (?:SELECT,)?INSERT[^\n]*customer_lane_policy_overrides/.test(runtimeRoles), 'activity role must not mutate lane policy');

console.log('lane entitlements, onboarding and impersonation smoke: ok');