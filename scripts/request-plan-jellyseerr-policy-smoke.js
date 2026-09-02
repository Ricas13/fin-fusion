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
const requestEntitlement = read('src/integrations/request-entitlement.js');
const requestUsers = read('src/platform/admin-request-users.js');
const jellyfinEditor = read('src/platform/admin-jellyfin-plan-editor.js');
const stremioEditor = read('src/platform/admin-stremio-plan-editor.js');
const bulkJobs = read('src/platform/bulk-jobs.js');
const bulkWorker = read('src/jellyfin/bulk-worker.js');
const nav = read('src/platform/admin-nav.js');
const plansList = read('src/platform/admin-plans-list.js');
const planCss = read('public/css/admin-plan-control-room.css');

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
assert(planUi.includes("res.redirect(302, '/admin/plans')"), 'legacy request-policy overview URL must redirect to canonical Plans');
assert(planUi.includes('queuePlanRequestReconciliation'), 'saving plan request policy must queue every current member for reconciliation');
assert(!nav.includes("'request-plan-limits'"), 'Request limits must not remain as a standalone Plans workflow tab');
assert(!plansList.includes('href="/admin/request-plan-policy"'), 'Plans must not expose a duplicate Request limits overview action');

assert(sync.includes('p.request_permissions') && sync.includes('p.request_access_enabled'), 'request sync must load plan-owned request policy');
assert(sync.includes('email,') && sync.includes('discoverRegion') && sync.includes('streamingRegion'), 'main-settings sync must retain email and modern Seerr region fields');
assert(!sync.includes('discordId:current?.discordId'), 'legacy partial main-settings payload must not return');
assert(sync.includes('syncSelected(customerIds)'), 'request sync must support selected-customer reconciliation');
assert(sync.includes('currentPermissions !== activePermissions'), 'managed plan permissions must be reconciled even for already-active users');
assert(sync.includes("require('./request-entitlement')") && sync.includes('resolveRequestCandidate(candidate)'), 'request sync must resolve non-Jellyfin service entitlements before suspending a customer');
for (const laneView of ['effective_customer_entitlements','effective_stremio_entitlements','effective_emby_entitlements']) {
  assert(requestEntitlement.includes(laneView), `request entitlement resolution must include ${laneView}`);
}
assert(requestEntitlement.includes('COALESCE(p.request_access_enabled,TRUE)=TRUE'), 'cross-service request entitlement must still respect each plan request-access switch');
assert(requestEntitlement.includes('ORDER BY e.blocked ASC,e.service_rank ASC'), 'cross-service request entitlement must prefer usable access while preserving the existing Jellyfin-first policy when multiple lanes qualify');

assert(requestUsers.includes('data-request-user-select-all'), 'request user table must have Select All');
assert(requestUsers.includes('/admin/request-users/sync-selected'), 'request user table must support Sync selected');
assert(requestUsers.includes('/admin/customers/bulk/preview'), 'bulk access changes must use the existing safe customer bulk preview');
assert(requestUsers.includes('value="plan_change"'), 'bulk access action must enter the canonical plan-change workflow');

assert(jellyfinEditor.includes('requestPlanPolicy.planCard(req, p)'), 'Jellyfin plans must embed the request policy card');
assert(stremioEditor.includes("requestPlanPolicy.planCard(req, p, { variant: 'stremio' })"), 'Stremio plans must embed the request policy card');
assert(!stremioEditor.includes("value=\"new_only\""), 'Stremio access changes must not leave existing plan members on an old household policy');
assert(stremioEditor.includes("updateTrackingSnapshots(client, data.plan, input, impact, 'all_current')"), 'Stremio plan saves must explicitly apply household policy to current members');
assert(stremioEditor.includes('queuePlanRequestReconciliation'), 'Stremio plan saves must reapply request policy to current members');

for (const predicate of ["superseded_by IS NULL", "'paused'", 'starts_at<=NOW()', 'current_period_end>NOW()']) {
  assert(bulkJobs.includes(predicate), `plan fanout must use canonical current-member predicate: ${predicate}`);
}
assert(bulkJobs.includes("'request_plan_reconcile'"), 'request-only plan fanout job must exist');
assert(bulkWorker.includes("registerHandler('request_plan_reconcile'"), 'bulk worker must execute request-only plan fanout');
assert(bulkWorker.includes('reconcileRequestUser(item.customer_id)'), 'full plan reconciliation must also keep request policy current');

assert(planCss.includes('.dataTable thead th{background:rgba(255,255,255,.10)'), 'admin tables must have a clearly lighter header band');
assert(planCss.includes('.planFamilySection>.sectionHead{background:rgba(255,255,255,.12)'), 'plan-family table sections must have strong visual separation');

console.log('request plan Jellyseerr policy smoke: ok');
