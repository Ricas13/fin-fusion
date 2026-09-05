'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const registry = read('src/jellyfin/registry.js');
const metrics = read('src/jellyfin/fleet-metrics.js');
const worker = read('scripts/activity-worker.js');
const inactivity = read('src/automation/customer-inactivity-scoped.js');

assert(registry.includes('cacheTtlMs=0'), 'registry requests must make response reuse opt-in');
assert(registry.includes('if(reusable&&ttl>0)') && registry.includes('responseCache.set'), 'GET responses must be retained and only reused by opt-in callers');
assert(registry.includes('else clearServerCache(serverId)'), 'media-server mutations must invalidate reusable GET snapshots');

assert(metrics.includes('cacheTtlMs: 45000'), 'fleet metrics must reuse the recent canonical /Sessions sample instead of forcing another Jellyfin request');
assert(metrics.includes('{ refreshUsers = true }') && metrics.includes("refreshUsers ? registry.request(serverId, '/Users'"), 'fleet metrics must be able to refresh live streams without polling /Users every time');
assert(metrics.includes('cachedTotalUsers(serverId)'), 'stream-only metric refreshes must preserve the last known user count');

assert(worker.includes('FLEET_USER_ACTIVITY_POLL_SECONDS || 300'), 'user activity polling must default to five minutes');
assert(worker.includes('fleetMetrics.refreshAll({ refreshUsers })'), 'the activity worker must keep live fleet metrics on the faster cadence while gating /Users refreshes separately');
assert(worker.includes('FLEET_METRICS_POLL_SECONDS || 60'), 'dashboard fleet metrics must retain the existing one-minute refresh cadence');

assert(inactivity.includes('refreshCandidateUserActivity(discovered') && inactivity.includes('finalEligibility(original'), 'Free Server inactivity must retain fresh Jellyfin user-activity verification and final pre-removal revalidation');

console.log('jellyfin poll dedupe smoke: ok');
