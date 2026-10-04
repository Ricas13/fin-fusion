'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const inactivity = require('../src/automation/customer-inactivity');
const scoped = require('../src/automation/customer-inactivity-scoped');
const legacyGrace = require('../src/entitlements/jellyfin-inactivity-grace');

const inactivitySource = read('src/automation/customer-inactivity.js');
const freeBackfillSource = read('src/automation/free-capacity-backfill.js');
assert(
    inactivitySource.includes('s.media_server_id') &&
    inactivitySource.includes('(fa.media_server_id IS NULL OR ja.server_id=fa.media_server_id)'),
    'Free inactivity must assess and remove only the persisted assigned Free media server when one exists'
);
assert(
    freeBackfillSource.includes('(s.media_server_id IS NULL OR ja.server_id=s.media_server_id)'),
    'Free capacity backfill must treat only the persisted assigned Free server as a ready account when assignment exists'
);

const policy = {
    firstPlaybackGraceDays: 3,
    playbackWindowDays: 7,
    minimumPlaybackMinutes: 30
};
const day = 86400000;
const now = Date.parse('2026-09-18T12:00:00.000Z');

// Rule 1: first playback inside the allocation grace.
const neverPlayed = inactivity.assessUsage({
    allocation_start_at: '2026-09-15T12:00:00.000Z',
    first_playback_at: null,
    last_playback_at: null,
    last_activity_at: '2026-09-18T11:59:00.000Z',
    playback_seconds: 0
}, policy, now);
assert.equal(neverPlayed.firstPlaybackEligible, true, 'Jellyfin login/activity must not satisfy first-play activation');
assert.equal(neverPlayed.usageEligible, false, 'rolling playback cannot apply before activation');

const stillInGrace = inactivity.assessUsage({
    allocation_start_at: '2026-09-16T12:00:00.000Z',
    playback_seconds: 0
}, policy, now);
assert.equal(stillInGrace.firstPlaybackEligible, false, 'new allocations must receive the full first-play grace');

// A late first playback must not retroactively satisfy Rule 1 just because the
// worker did not run exactly at the deadline.
const lateFirstPlayback = inactivity.assessUsage({
    allocation_start_at: '2026-09-15T12:00:00.000Z',
    first_playback_at: '2026-09-18T12:00:01.000Z',
    last_playback_at: '2026-09-18T12:10:00.000Z',
    playback_seconds: 10 * 60
}, policy, Date.parse('2026-09-18T12:10:01.000Z'));
assert.equal(lateFirstPlayback.firstPlaybackEligible, true, 'first playback after the grace deadline must still fail Rule 1');
assert.equal(lateFirstPlayback.firstPlaybackOnTime, false, 'late playback must not activate the allocation');
assert.equal(lateFirstPlayback.usageEligible, false, 'Rule 2 must not replace a missed first-play deadline');

// Playback before the current allocation is irrelevant.
const oldPlayback = inactivity.assessUsage({
    allocation_start_at: '2026-09-15T12:00:00.000Z',
    first_playback_at: '2026-09-10T12:00:00.000Z',
    last_playback_at: '2026-09-10T12:30:00.000Z',
    playback_seconds: 0
}, policy, now);
assert.equal(oldPlayback.hasPlayback, false, 'playback before the current allocation must not activate it');
assert.equal(oldPlayback.firstPlaybackEligible, true, 'old playback must not prevent first-play removal');

// Rule 2: after activation, wait one full playback window, then require the
// rolling minimum. There is no separate login/activity rule.
const activatedRecently = inactivity.assessUsage({
    allocation_start_at: '2026-09-10T12:00:00.000Z',
    first_playback_at: '2026-09-12T12:00:00.000Z',
    last_playback_at: '2026-09-12T12:20:00.000Z',
    playback_seconds: 20 * 60
}, policy, Date.parse('2026-09-18T11:59:00.000Z'));
assert.equal(activatedRecently.usageEligible, false, 'activation must receive one complete rolling window before retention enforcement');

const belowMinimum = inactivity.assessUsage({
    allocation_start_at: '2026-09-01T12:00:00.000Z',
    first_playback_at: '2026-09-03T12:00:00.000Z',
    last_playback_at: '2026-09-09T12:00:00.000Z',
    last_activity_at: '2026-09-18T11:59:00.000Z',
    playback_seconds: 29 * 60
}, policy, Date.parse('2026-09-10T12:00:01.000Z'));
assert.equal(belowMinimum.firstPlaybackOnTime, true, 'rolling-minimum fixture must first satisfy the first-play grace');
assert.equal(belowMinimum.usageEligible, true, '29 minutes must fail after the full seven-day observation window');

const minimumMet = inactivity.assessUsage({
    allocation_start_at: '2026-09-01T12:00:00.000Z',
    first_playback_at: '2026-09-03T12:00:00.000Z',
    last_playback_at: '2026-09-09T12:00:00.000Z',
    playback_seconds: 30 * 60
}, policy, Date.parse('2026-09-10T12:00:01.000Z'));
assert.equal(minimumMet.usageEligible, false, '30 minutes must satisfy the rolling requirement');

// Free Plan settings are authoritative once configured, with a safe legacy
// server fallback so an upgrade cannot silently change existing deadlines.
const effective = inactivity.planPolicy({
    plan_free_first_playback_grace_days: 4,
    plan_free_playback_window_days: 9,
    plan_free_minimum_playback_minutes: 45,
    free_first_playback_grace_days: 3,
    free_playback_window_days: 7,
    free_minimum_playback_minutes: 30
}, { enabled: true, dryRun: false });
assert.deepStrictEqual(
    {
        enabled: effective.enabled,
        dryRun: effective.dryRun,
        firstPlaybackGraceDays: effective.firstPlaybackGraceDays,
        playbackWindowDays: effective.playbackWindowDays,
        minimumPlaybackMinutes: effective.minimumPlaybackMinutes,
        thresholdOwner: effective.thresholdOwner
    },
    {
        enabled: true,
        dryRun: false,
        firstPlaybackGraceDays: 4,
        playbackWindowDays: 9,
        minimumPlaybackMinutes: 45,
        thresholdOwner: 'free_plan'
    }
);
const legacyFallback = inactivity.planPolicy({
    free_first_playback_grace_days: 5,
    free_playback_window_days: 12,
    free_minimum_playback_minutes: 50
}, { enabled: true, dryRun: false });
assert.equal(legacyFallback.thresholdOwner, 'free_server_legacy_fallback');
assert.equal(legacyFallback.firstPlaybackGraceDays, 5);
assert.equal(legacyFallback.playbackWindowDays, 12);
assert.equal(legacyFallback.minimumPlaybackMinutes, 50);
assert.equal(Object.prototype.hasOwnProperty.call(effective, 'noPlaybackDays'), false, 'there must be no hidden login/activity retention rule');
assert.equal(Object.prototype.hasOwnProperty.call(effective, 'minimumObservationHours'), false, 'there must be no second hidden observation timer');

// Only explicit admin-present/permanent access protects Free inactivity.
// Server pinning is placement only.
assert.equal(scoped.adminProtectedFreeEntitlement({ admin_jellyfin_mode: 'forced_server' }), false);
assert.equal(scoped.adminProtectedFreeEntitlement({ admin_jellyfin_mode: 'present' }), true);
assert.equal(scoped.adminProtectedFreeEntitlement({ admin_present: true, admin_jellyfin_mode: 'forced_server' }), false,'the SQL admin-present compatibility boolean must not turn a server pin into protection');
assert.equal(scoped.adminProtectedFreeEntitlement({ permanent_access: true }), true);

// The one-time legacy lane repair may delay enforcement, but normal restore /
// return-to-automation timing is owned by the allocation boundary itself.
const graceRow = {
    policy,
    inactivity_observation_reset_at: new Date(now - 2 * day),
    eligible: true,
    reasons: []
};
(async () => {
    const rows = await legacyGrace.applyLegacySafetyWindow([graceRow], { now });
    assert.equal(rows[0].eligible, false, 'legacy lane repair must retain its one-time safety window');
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});

const base = read('src/automation/customer-inactivity.js');
const enforcement = read('src/automation/customer-inactivity-scoped.js');
const grace = read('src/entitlements/jellyfin-inactivity-grace.js');
const status = read('src/automation/customer-inactivity-status.js');
const adminControl = read('src/jellyfin/admin-control.js');
const subscriptionState = read('src/entitlements/subscription-state.js');
const lifecycleAdmin = read('src/platform/admin-jellyfin-lifecycle.js');
const planAdmin = read('src/platform/admin-request-plan-policy.js');
const pinPlacementMigration = read('db/migrations/20260918001000_server_pin_placement_only.sql');
const cleanupReturn = read('src/entitlements/jellyfin-cleanup-return.js');

// Allocation is one boundary: subscription start, actual account creation,
// lane transition, or a later return from Permanent Access -- whichever is newest.
assert.match(base, /GREATEST\([\s\S]*?fa\.starts_at[\s\S]*?ja\.created_at[\s\S]*?ja\.access_lane_changed_at[\s\S]*?automation_resume\.resumed_at/);
assert.doesNotMatch(base, /historical_first_playback_at|any_playback_history|WHEN historical\./, 'historical activation heuristics must be gone');
assert.doesNotMatch(base, /lifecycle\.restored_at/, 'newly-created restored accounts must use their own creation boundary');
assert.match(base, /COALESCE\(s\.service_extension_days,0\)>0[\s\S]*?s\.current_period_end\+\(\(s\.service_extension_days\|\|' days'\)::interval\)>NOW\(\)/, 'Free inactivity discovery must include the same live service-extension episodes as canonical entitlement truth');
assert.match(base, /ORDER BY s\.customer_id,s\.created_at DESC/, 'Free inactivity discovery must choose the canonical newest Free subscription episode');

// Rolling watch time must count only the overlap with the exact rolling window,
// not discard a whole session merely because it started just before the cutoff.
assert.match(base, /MIN\(ph\.started_at\) FILTER \(\s*WHERE ph\.started_at>=allocation\.allocation_start_at/,'only playback that starts inside the current Free allocation may activate it');
assert.match(base, /WHERE ph\.started_at>=allocation\.allocation_start_at/,'pre-allocation playback must stay excluded even when it overlaps the allocation boundary');
assert.match(base, /LEAST\(COALESCE\(ph\.ended_at,ph\.last_seen_at\),NOW\(\)\)/);
assert.match(base, /GREATEST\([\s\S]*?ph\.started_at[\s\S]*?COALESCE\(fa\.plan_free_playback_window_days,js\.free_playback_window_days,7\)/,'sessions must use the plan-owned rolling window with a safe legacy server fallback');
assert.match(base, /EXISTS\([\s\S]*?active_playback_sessions[\s\S]*?aps\.jellyfin_account_id=ja\.id/, 'currently-playing protection must target the exact account');
assert.match(base, /ph\.jellyfin_account_id=ja\.id[\s\S]*?ph\.jellyfin_account_id IS NULL[\s\S]*?ph\.access_lane_snapshot='free'[\s\S]*?ph\.access_lane_snapshot IS NULL/, 'Free playback must keep exact-account activity, retain unknown legacy orphan history conservatively, and exclude orphan rows known to belong to the paid lane');
assert.doesNotMatch(base, /noPlaybackEligible|noPlaybackDays/, 'Free inactivity must have no login/activity timer');

// Enforcement must delete exactly the selected Free account, then end the exact
// Free subscription and release the temporary inactivity hold. The portal user
// survives, but there is no retained/restorable Free plan.
assert.match(enforcement, /await provisioning\.deleteJellyfinAccount\(/);
assert.match(enforcement, /entitlement\.subscription_id[\s\S]*?fresh\.subscription_id/, 'final destructive recheck must require the exact Free subscription episode');
const removeEligibleStart=enforcement.indexOf('async function removeEligibleAccount');
const runPlanRulesStart=enforcement.indexOf('async function runPlanRules',removeEligibleStart);
const removeEligibleSource=enforcement.slice(removeEligibleStart,runPlanRulesStart);
assert.doesNotMatch(removeEligibleSource, /await provisioning\.reconcileCustomer\(/, 'inactivity removal must not invoke broad reconciliation');
assert.match(enforcement, /await accessHolds\.addHold\([\s\S]*?await provisioning\.deleteJellyfinAccount/, 'the durable inactivity hold must exist before deletion');
assert.match(enforcement, /await verifyRemoved\(row\.account_id\)[\s\S]*?await finishRemovedFreePlan/, 'the Free plan must end only after Jellyfin deletion is verified');
assert.match(enforcement, /subscriptionTermination\.terminateLocal\([\s\S]*?Free Server plan ended after inactivity removal/, 'successful inactivity removal must terminate the exact Free subscription');
const termination=read('src/payments/subscription-termination.js');
assert.match(termination,/permanentOnOtherSubscription&&\(!subscription\.is_free_tier\|\|!permanentOnOtherPrimary\)/,'Free subscription termination must preserve only Permanent Access proven to belong to the independent paid\/primary lane');
assert.match(enforcement, /finishRemovedFreePlan[\s\S]*?accessHolds\.releaseHold/, 'terminal removal must release its temporary inactivity hold');
assert.match(enforcement, /finalizeDetachedRemovals/, 'partial legacy removals with an already-deleted account must be finalized on later worker runs');
assert(enforcement.indexOf("'customer.inactivity.remove_jellyfin'") > enforcement.indexOf('await finishRemovedFreePlan'), 'successful removal audit must be written only after plan termination and hold release');
assert.doesNotMatch(enforcement, /refreshServerUserActivity|candidate_user_not_observed_in_fresh_users_response/, 'login/user-inventory refresh must not be a retention rule');
assert.doesNotMatch(enforcement, /massRemovalRisk|CIRCUIT_BREAKER_/, 'retired mass-removal rules must be gone');
assert.doesNotMatch(enforcement, /forceDryRun/, 'configured dry-run must be the only execution-mode authority');
assert.doesNotMatch(enforcement, /usageSatisfiedEarlierToday/, 'the same rolling playback query must be the single usage authority');

// Server pins cannot erase blockers.
const pinBranch = adminControl.slice(
    adminControl.indexOf("control.mode==='admin_server_pin'"),
    adminControl.indexOf('return decorated', adminControl.indexOf("control.mode==='admin_server_pin'"))
);
assert(!pinBranch.includes('decorated.blocked=false'));
assert.match(subscriptionState,/row=await applyOperatorSemantics\(db,row,\{includeBlocked:true\}\)/,'Free entitlement truth must decorate the real admin mode before deciding whether a hold is bypassed');
assert.match(subscriptionState,/row\.permanent_access\|\|row\.admin_jellyfin_mode==='present'/,'only permanent or explicit admin-present may bypass a Free inactivity hold');
assert.doesNotMatch(subscriptionState,/if\(row\.admin_present\)\{row\.blocked=false/,'server pin compatibility must never clear a Free inactivity hold');
assert.match(pinPlacementMigration,/c\.mode='admin_present'/,'database admin-present authority must still protect explicit grants');
assert.doesNotMatch(pinPlacementMigration,/mode IN \('admin_present','admin_server_pin'\)/,'database entitlement authority must not treat server pinning as access protection');

// Restore/re-add complexity is reduced to the allocation clock. The grace
// helper now only knows the one-time legacy migration marker.
assert.doesNotMatch(grace, /customer_entitlement_overrides|jellyfin_account_lifecycle|admin_restore|automation_resume/);
assert.match(grace, /async function applyLegacySafetyWindow/);
assert.match(grace, /inactivity_observation_reset_at/);
assert.match(grace, /module\.exports = \{ applyLegacySafetyWindow \}/,'legacy safety module must expose one runtime concept only');

// Customer return cleanup is now deliberately separate from Free inactivity.
assert.doesNotMatch(cleanupReturn, /jellyfin-inactivity-restore|restoreDisabledFreeAccess|declineDeletedFreeAccess/,'customer portal cleanup must never resurrect an inactivity-removed Free plan');
assert.match(cleanupReturn, /canRestoreDeletedFree:false/,'compatibility status must explicitly report that Free inactivity is not restorable');
assert.match(cleanupReturn, /Free Server inactivity is terminal/,'the lifecycle boundary must be documented next to the customer-return state');

// Status and admin UI must describe the same two rules.
assert.doesNotMatch(status, /refreshCandidateUserActivity/);
assert.match(lifecycleAdmin, /Free Server inactivity has two rules/);
assert.match(lifecycleAdmin, /Thresholds belong to the Free Plan/);
assert.doesNotMatch(lifecycleAdmin, /Free Jellyfin plan and are edited from Plans/);
assert.match(planAdmin, /Inactivity thresholds are owned by the Free plan/);

console.log('Free Access inactivity consistency smoke: ok');
