'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
const policy = require('../src/integrations/request-plan-policy');

const migration = read('db/migrations/030_request_plan_user_policy.sql');
const planUi = read('src/platform/admin-request-plan-policy.js');
const sync = read('src/integrations/request-user-sync.js');
const requestUsers = read('src/platform/admin-request-users.js');
const jellyfinEditor = read('src/platform/admin-jellyfin-plan-editor.js');
const stremioEditor = read('src/platform/admin-stremio-plan-editor.js');

for (const column of [
  'request_access_enabled', 'request_permissions',
  'request_watchlist_sync_movies', 'request_watchlist_sync_tv',
  'request_locale', 'request_discover_region', 'request_streaming_region',
  'request_original_language'
]) assert(migration.includes(column), `migration must add ${column}`);

assert.strictEqual(policy.sanitizePermissionMask(2 | 32), 32, 'ADMIN must be stripped from a plan-managed permission mask');
assert.strictEqual(policy.sanitizePermissionMask(8 | 16 | 32), 32, 'user/request management permissions must be stripped');
assert(policy.CUSTOMER_PERMISSION_DEFS.some(item => item.bit === 262144), 'movie-request permission must be configurable');
assert(policy.CUSTOMER_PERMISSION_DEFS.some(item => item.bit === 524288), 'TV-request permission must be configurable');
for (const privileged of [2, 4, 8, 16, 1048576, 268435456]) {
  assert(!policy.CUSTOMER_PERMISSION_DEFS.some(item => item.bit === privileged), `privileged permission ${privileged} must not be plan-configurable`);
}

assert(planUi.includes('Requests / Jellyseerr'), 'plan policy must render as a Requests / Jellyseerr card');
assert(planUi.includes('permissionMode'), 'plan policy must support preserve vs managed permission modes');
assert(planUi.includes('requestAccessEnabled'), 'plan policy must control request-service access');
assert(planUi.includes('watchlistSyncMovies') && planUi.includes('watchlistSyncTv'), 'plan policy must expose watchlist defaults');
assert(planUi.includes('discoverRegion') && planUi.includes('streamingRegion'), 'plan policy must expose modern Seerr region defaults');
assert(planUi.includes('Username, email, password and personal notification destinations remain user-owned'), 'plan UI must make the identity/privacy boundary explicit');

assert(sync.includes('p.request_permissions') && sync.includes('p.request_access_enabled'), 'request sync must load plan-owned request policy');
assert(sync.includes('email,') && sync.includes('discoverRegion') && sync.includes('streamingRegion'), 'main-settings sync must retain email and modern Seerr region fields');
assert(!sync.includes('discordId:current?.discordId'), 'legacy partial main-settings payload must not return');
assert(sync.includes('syncSelected(customerIds)'), 'request sync must support selected-customer reconciliation');
assert(sync.includes('currentPermissions !== activePermissions'), 'managed plan permissions must be reconciled even for already-active users');

assert(requestUsers.includes('data-request-user-select-all'), 'request user table must have Select All');
assert(requestUsers.includes('/admin/request-users/sync-selected'), 'request user table must support Sync selected');
assert(requestUsers.includes('/admin/customers/bulk/preview'), 'bulk access changes must use the existing safe customer bulk preview');
assert(requestUsers.includes('value="plan_change"'), 'bulk access action must enter the canonical plan-change workflow');

assert(jellyfinEditor.includes('requestPlanPolicy.planCard(req, p)'), 'Jellyfin plans must embed the request policy card');
assert(stremioEditor.includes("requestPlanPolicy.planCard(req,p,{variant:'stremio'})"), 'Stremio plans must embed the request policy card');

console.log('request plan Jellyseerr policy smoke: ok');
