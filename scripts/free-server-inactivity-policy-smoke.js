'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const inactivity = require('../src/automation/customer-inactivity');

const globalEnabled = { enabled: true, dryRun: false };
const defaults = inactivity.serverPolicy({}, globalEnabled);
assert.strictEqual(defaults.firstPlaybackGraceDays, 3, 'default first-play grace must remain three days');
assert.strictEqual(defaults.playbackWindowDays, 7, 'default activity window must remain seven days');
assert.strictEqual(defaults.minimumPlaybackMinutes, 30, 'default playback minimum must remain thirty minutes');
assert.strictEqual(defaults.enabled, true, 'global execution switch must remain authoritative');

const custom = inactivity.serverPolicy({
    free_first_playback_grace_days: 5,
    free_playback_window_days: 14,
    free_minimum_playback_minutes: 60
}, { enabled: true, dryRun: true });
assert.strictEqual(custom.firstPlaybackGraceDays, 5);
assert.strictEqual(custom.noPlaybackDays, 14);
assert.strictEqual(custom.playbackWindowDays, 14);
assert.strictEqual(custom.minimumPlaybackMinutes, 60);
assert.strictEqual(custom.dryRun, true, 'global dry-run switch must remain authoritative');

const now = Date.parse('2026-09-17T12:00:00.000Z');
let assessment = inactivity.assessUsage({
    allocation_start_at: '2026-09-13T12:00:00.000Z',
    first_playback_at: null,
    last_playback_at: null,
    playback_seconds: 0
}, custom, now);
assert.strictEqual(assessment.firstPlaybackEligible, false, 'four days must still be inside a five-day first-play grace');

assessment = inactivity.assessUsage({
    allocation_start_at: '2026-09-11T12:00:00.000Z',
    first_playback_at: null,
    last_playback_at: null,
    playback_seconds: 0
}, custom, now);
assert.strictEqual(assessment.firstPlaybackEligible, true, 'six days must breach a five-day first-play grace');

assessment = inactivity.assessUsage({
    allocation_start_at: '2026-09-01T12:00:00.000Z',
    first_playback_at: '2026-09-02T12:00:00.000Z',
    last_playback_at: '2026-09-05T12:00:00.000Z',
    playback_seconds: 59 * 60
}, custom, now);
assert.strictEqual(assessment.usageEligible, true, '59 minutes must breach a sixty-minute minimum after the fourteen-day window');

assessment = inactivity.assessUsage({
    allocation_start_at: '2026-09-01T12:00:00.000Z',
    first_playback_at: '2026-09-02T12:00:00.000Z',
    last_playback_at: '2026-09-05T12:00:00.000Z',
    playback_seconds: 60 * 60
}, custom, now);
assert.strictEqual(assessment.usageEligible, false, 'meeting the configured playback minimum must keep the user safe');

const root = path.resolve(__dirname, '..');
const workerSource = fs.readFileSync(path.join(root, 'src/automation/customer-inactivity.js'), 'utf8');
assert.match(workerSource, /js\.free_first_playback_grace_days/);
assert.match(workerSource, /js\.free_playback_window_days/);
assert.match(workerSource, /js\.free_minimum_playback_minutes/);
assert.match(workerSource, /NOW\(\)-\(js\.free_playback_window_days\|\|' days'\)::interval/,
    'rolling playback SQL must use the assigned server activity window');

const adminSource = fs.readFileSync(path.join(root, 'src/platform/admin-servers.js'), 'utf8');
for (const field of ['freeFirstPlaybackGraceDays', 'freePlaybackWindowDays', 'freeMinimumPlaybackMinutes']) {
    assert(adminSource.includes(field), `server admin must persist ${field}`);
}

const view = fs.readFileSync(path.join(root, 'views/admin/server-form.ejs'), 'utf8');
for (const field of ['freeFirstPlaybackGraceDays', 'freePlaybackWindowDays', 'freeMinimumPlaybackMinutes']) {
    assert(view.includes(`name="${field}"`), `server form must expose ${field}`);
}

const migration = fs.readFileSync(path.join(root, 'db/migrations/20260917190000_free_server_inactivity_policy.sql'), 'utf8');
assert(migration.includes('DEFAULT 3'));
assert(migration.includes('DEFAULT 7'));
assert(migration.includes('DEFAULT 30'));

console.log('Free Server per-server inactivity policy smoke: ok');
