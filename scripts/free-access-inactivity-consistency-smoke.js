'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const inactivity = require('../src/automation/customer-inactivity');
const scoped = require('../src/automation/customer-inactivity-scoped');
const legacyGrace = require('../src/entitlements/jellyfin-inactivity-grace');

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
    first_playback_at: '2026-09-10T12:00:00.000Z',
    last_playback_at: '2026-09-16T12:00:00.000Z',
    last_activity_at: '2026-09-18T11:59:00.000Z',
    playback_seconds: 29 * 60
}, policy, Date.parse('2026-09-18T12:00:01.000Z'));
assert.equal(belowMinimum.usageEligible, true, '29 minutes must fail after the full seven-day observation window');

const minimumMet = inactivity.assessUsage({
    allocation_start_at: '2026-09-01T12:00:00.000Z',
    first_playback_at: '2026-09-10T12:00:00.000Z',
    last_playback_at: '2026-09-16T12:00:00.000Z',
    playback_seconds: 30 * 60
}, policy, Date.parse('2026-09-18T12:00:01.000Z'));
assert.equal(minimumMet.usageEligible, false, '30 minutes must satisfy the rolling requirement');

// Server settings are the only threshold source.
const effective = inactivity.serverPolicy({
    free_first_playback_grace_days: 4,
    free_playback_window_days: 9,
    free_minimum_playback_minutes: 45
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
        thresholdOwner: 'free_server'
    }
);
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

// Allocation is one boundary: subscription start, actual account creation,
// lane transition, or a later return from Permanent Access -- whichever is newest.
assert.match(base, /GREATEST\([\s\S]*?fa\.starts_at[\s\S]*?ja\.created_at[\s\S]*?ja\.access_lane_changed_at[\s\S]*?automation_resume\.resumed_at/);
assert.doesNotMatch(base, /historical_first_playback_at|any_playback_history|WHEN historical\./, 'historical activation heuristics must be gone');
assert.doesNotMatch(base, /lifecycle\.restored_at/, 'newly-created restored accounts must use their own creation boundary');

// Rolling watch time must count only the overlap with the exact rolling window,
// not discard a whole session merely because it started just before the cutoff.
assert.match(base, /LEAST\(COALESCE\(ph\.ended_at,ph\.last_seen_at\),NOW\(\)\)/);
assert.match(base, /GREATEST\([\s\S]*?ph\.started_at[\s\S]*?allocation\.allocation_start_at[\s\S]*?NOW\(\)-\(js\.free_playback_window_days/);
assert.match(base, /EXISTS\([\s\S]*?active_playback_sessions[\s\S]*?aps\.jellyfin_account_id=ja\.id/, 'currently-playing protection must target the exact account');
assert.doesNotMatch(base, /noPlaybackEligible|noPlaybackDays/, 'Free inactivity must have no login/activity timer');

// Enforcement must delete exactly the selected Free account and persist a hold;
// it must not route deletion through the broad entitlement reconciler.
assert.match(enforcement, /await provisioning\.deleteJellyfinAccount\(/);
assert.doesNotMatch(enforcement, /await provisioning\.reconcileCustomer\(/, 'inactivity removal must not invoke broad reconciliation');
assert.match(enforcement, /await accessHolds\.addHold\([\s\S]*?await provisioning\.deleteJellyfinAccount/, 'the durable inactivity hold must exist before deletion');
assert(enforcement.indexOf("'customer.inactivity.remove_jellyfin'") > enforcement.indexOf('await verifyRemoved(row.account_id)'), 'successful removal audit must be written only after deletion is verified');
assert.doesNotMatch(enforcement, /refreshServerUserActivity|candidate_user_not_observed_in_fresh_users_response/, 'login/user-inventory refresh must not be a retention rule');
assert.doesNotMatch(enforcement, /massRemovalRisk|CIRCUIT_BREAKER_/, 'retired mass-removal rules must be gone');
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

// Status and admin UI must describe the same two rules.
assert.doesNotMatch(status, /refreshCandidateUserActivity/);
assert.match(lifecycleAdmin, /Free Server inactivity has two rules/);
assert.match(lifecycleAdmin, /Thresholds belong to each Free-class media server/);
assert.doesNotMatch(lifecycleAdmin, /Free Jellyfin plan and are edited from Plans/);
assert.match(planAdmin, /Inactivity thresholds are owned by the Free media server/);

console.log('Free Access inactivity consistency smoke: ok');
