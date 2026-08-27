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
assert(/Premium Jellyfin policy/.test(adminLane)&&/Free Access policy/.test(adminLane), 'Customer 360 must show separate Premium and Free policy sections');
assert(/name="accessLane" value="\$\{esc\(accessLane\)\}"/.test(adminLane), 'policy mutation forms must submit the lane explicitly');
assert(/setPolicyOverrideField\(req\.params\.customerId,\s*accessLane/.test(adminLane), 'admin override writes must be lane scoped');
const lanePos = composition.indexOf('app.use(createAdminLanePolicyRouter())');
const customer360Pos = composition.indexOf('app.use(createAdminCustomer360Router())');
assert(lanePos >= 0 && customer360Pos >= 0 && lanePos < customer360Pos, 'lane policy middleware must wrap Customer 360 before it owns the response');

// Impersonation's audit-and-banner middleware must run before ANY /account
// router that can terminate the response itself -- otherwise customer
// mutations made while impersonating (checkout, password change, plan
// actions) never reach the audit pass at all.
const impersonationAppPos = application.indexOf('app.use(createAdminImpersonationRouter())');
const passwordSyncPos = application.indexOf('app.use(createCustomerPasswordSyncRouter())');
const subscriptionActionsPos = application.indexOf('app.use(createCustomerSubscriptionActionsRouter())');
const checkoutPos = application.indexOf('app.use(createFlexibleCheckoutRouter())');
assert(impersonationAppPos >= 0 && passwordSyncPos >= 0 && subscriptionActionsPos >= 0 && checkoutPos >= 0
    && impersonationAppPos < passwordSyncPos && impersonationAppPos < subscriptionActionsPos && impersonationAppPos < checkoutPos,
    'impersonation audit/banner middleware must be mounted before every /account router so it can see all customer mutations made while impersonating');

// Imported-user onboarding can deliberately create an email-less portal identity.
assert(/Email <span class="help">\(optional\)<\/span>/.test(customerClaim), 'imported claim page must present email as optional');
assert(/Optional\. You can sign in with the portal username even without an email/.test(customerClaim), 'email-less login guidance missing from claim page');
assert(/cleanEmail\(email,false\)/.test(claims), 'claim redemption must accept a missing email');
assert(/INSERT INTO app_users\(email,username,password_hash/.test(claims), 'claim redemption must create the portal identity without inventing an email');
assert(/lower\(u\.email\)=lower\(\$1\) OR lower\(u\.username\)=lower\(\$1\)/.test(customers), 'portal login must accept username or email');
assert(/async function changePortalPassword/.test(customers)&&/password_hash/.test(customers), 'portal password change must exist independently of email');
assert(/\/account\/security\/password/.test(security), 'Account Security must expose portal password change');
assert(/customer_no_email_verification_state/.test(migration), 'email-less imported users must not be trapped by the email-verification gate');

// Admin impersonation uses the real portal while preserving privileged identity.
assert(/View portal as customer/.test(impersonation), 'Customer 360 impersonation action missing');
assert(/Nested impersonation is not allowed/.test(impersonation), 'nested impersonation must be blocked');
assert(/row\?\.role === 'customer'/.test(impersonation), 'privileged/admin targets must not be impersonable');
assert(/req\.session\.impersonation = \{/.test(impersonation)&&/actorUserId: req\.session\.authUserId/.test(impersonation), 'real admin actor identity must remain attached to impersonation');
assert(/req\.session\.customerId = target\.customer_id/.test(impersonation)&&/return res\.redirect\('\/account'\)/.test(impersonation), 'impersonation must enter the real customer portal');
assert(/Impersonating \$\{esc\(label\)\}/.test(impersonation)&&/Exit impersonation/.test(impersonation), 'persistent impersonation banner/exit control missing');
assert(/admin\.impersonation\.start/.test(impersonation)&&/admin\.impersonation\.end/.test(impersonation)&&/admin\.impersonation\.customer_action/.test(impersonation), 'impersonation lifecycle and mutations must be audited');
assert(!/password_hash|currentPassword|setJellyfinPassword/.test(impersonation), 'impersonation must never read or bypass customer passwords');

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
