'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const identity = require('../src/jellyfin/identity-reconciliation');
const orphanCleanup = require('../src/stremio/orphan-account-cleanup');
const accessState = require('../src/access/customer-access-state');

function source(file) {
  return fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
}

(function classificationContracts() {
  const remote = { jellyfin_username: 'ordinary-user' };
  assert.strictEqual(identity.classificationFor({
    remote,
    candidates: [],
    existingAccounts: [],
    access: null
  }), 'unmatched_orphan');

  assert.strictEqual(identity.classificationFor({
    remote,
    candidates: [{ customer_id: 'c1', match: 'customer_email' }],
    existingAccounts: [],
    access: { primary_state: accessState.ACCESS_STATES.ACTIVE_BLOCKED }
  }), 'access_leak');

  assert.strictEqual(identity.classificationFor({
    remote,
    candidates: [{ customer_id: 'c1', match: 'portal_email' }],
    existingAccounts: [{ account_purpose: 'jellyfin' }],
    access: { primary_state: accessState.ACCESS_STATES.ACTIVE_READY }
  }), 'possible_duplicate');

  assert.strictEqual(identity.classificationFor({
    remote: { jellyfin_username: 'cf_stremio_1d25afae216c' },
    candidates: [],
    existingAccounts: [],
    access: null
  }), 'stremio_orphan');

  assert.strictEqual(identity.confidence('portal_email'), 'strong');
  assert.strictEqual(identity.confidence('display_name'), 'weak');
  assert.strictEqual(identity.stremioManagedUsername('cf_stremio_1d25afae216c'), true);
  assert.strictEqual(identity.stremioManagedUsername('cf_stremio_1d25afae216c7585'), true);
  assert.strictEqual(identity.stremioManagedUsername('ordinary-user'), false);
})();

(function orphanContracts() {
  assert(orphanCleanup.INTERNAL_USER_RE.test('cf_stremio_1d25afae216c'));
  assert(orphanCleanup.INTERNAL_USER_RE.test('cf_stremio_1d25afae216c7585'));
  assert.strictEqual(orphanCleanup.managedUsernameToken('cf_stremio_1d25afae216c'), '1d25afae216c');
  assert.strictEqual(orphanCleanup.managedUsernameToken('cf_stremio_1d25afae216c7585'), '1d25afae216c');
  assert.strictEqual(orphanCleanup.managedUsernameToken('cf_stremio_customer'), null);
  assert(!orphanCleanup.INTERNAL_USER_RE.test('cf_stremio_customer'));
  assert(!orphanCleanup.INTERNAL_USER_RE.test('normal-user'));

  const now = new Date('2026-10-04T12:00:00Z');
  assert.strictEqual(orphanCleanup.recentEnough({ LastActivityDate: '2026-10-04T11:00:00Z' }, 12, now), true);
  assert.strictEqual(orphanCleanup.recentEnough({ LastActivityDate: '2026-10-03T20:00:00Z' }, 12, now), false);
  assert.strictEqual(orphanCleanup.recentEnough({}, 12, now), false);
  assert.strictEqual(orphanCleanup.mostRecentRemoteActivity({}), null);
  assert.strictEqual(orphanCleanup.graceHours('0'), 1);
  assert.strictEqual(orphanCleanup.graceHours('999'), 168);
})();

(function integrationSurfaceContracts() {
  const jobs = source('src/automation/jobs.js');
  assert(jobs.includes("const stremioOrphanCleanup=require('../stremio/orphan-account-cleanup');"));
  assert(jobs.includes("async stremio_managed_accounts(){const managed=await stremioManagedSweep.syncActiveBounded();"), 'Critical Stremio managed-account reconciliation must run before orphan cleanup.');
  assert(jobs.includes("if(Number(managed?.failed||0)>0)return{...managed,orphanCleanup:{processed:0,deleted:0,skipped:0,failed:0,disabled:'managed_reconciliation_failed'}}"), 'A managed-account reconciliation failure must disable destructive orphan cleanup for that run.');
  assert(jobs.includes("try{orphanCleanup=await stremioOrphanCleanup.run({apply:true,limit:5})}catch(error)"), 'Non-critical orphan cleanup failures must not throw the critical managed-account job.');
  assert(jobs.includes("return{...managed,...(warning?{warning}:{}),orphanCleanup}"), 'Orphan cleanup degradation must be surfaced as a warning while preserving managed reconciliation status.');
  assert(!jobs.includes("stremio_orphan_cleanup:{defaultIntervalSeconds:300"), 'Orphan cleanup must not be independently scheduled from managed reconciliation.');

  const cleanup = source('src/stremio/orphan-account-cleanup.js');
  assert(cleanup.includes("String(server.media_server_type || 'jellyfin').toLowerCase() === 'jellyfin'"), 'Stremio orphan cleanup must never sweep Emby servers.');
  assert(cleanup.includes('FROM jellyfin_accounts'));
  assert(!cleanup.includes("WHERE account_purpose='stremio_internal'"), 'Automatic orphan cleanup must protect any locally managed identity, not only Stremio-purpose rows.');
  assert(cleanup.includes('jellyfin_account_creation_intents'));
  assert(cleanup.includes("'/Sessions'"));
  assert(cleanup.includes("if (!Array.isArray(sessions)) throw new Error('Media server did not return a valid session list.')"), 'Inventory must fail closed when session state is malformed.');
  assert(cleanup.includes("reason: 'session_state_unavailable'"), 'Deletion race check must fail closed when session state is malformed.');
  assert(!cleanup.includes("'/Sessions', { timeoutMs: 10000 }).catch(() => [])"), 'Destructive orphan cleanup must fail closed when session state is unavailable.');
  assert(cleanup.includes("status = 'provisioning_in_flight'"));
  assert(cleanup.includes("status = 'active_entitlement_unlinked'"), 'An active Stremio entitlement with a lost local mapping must be protected from orphan deletion.');
  assert(cleanup.includes('effective_stremio_entitlements') && cleanup.includes('effective_customer_addons'), 'Orphan cleanup must independently consult active Stremio entitlement truth rather than relying only on the bounded managed sweep.');
  assert(cleanup.includes("reason: 'active_entitlement_now'"), 'Deletion race check must re-read active entitlement ownership immediately before DELETE.');
  assert(cleanup.indexOf("reason: 'active_entitlement_now'") < cleanup.indexOf("method: 'DELETE'"), 'Active-entitlement guard must run before remote deletion.');
  assert(cleanup.includes("status = 'active_session'"));
  assert(cleanup.includes("status = 'activity_unknown'"), 'Remote identities without a trustworthy activity timestamp must require operator review instead of automatic deletion.');
  assert(cleanup.includes("status = 'recent_activity'"));
  assert(cleanup.includes("const users = await registry.request(row.server_id, '/Users'"), 'Deletion race check must re-read the remote identity immediately before DELETE.');
  assert(cleanup.includes("reason: 'administrator_now'") && cleanup.includes("reason: 'activity_unknown_now'") && cleanup.includes("reason: 'recent_activity_now'") && cleanup.includes("reason: 'identity_changed_now'"), 'Late admin/activity/identity changes and unknown activity age must fail closed.');
  assert(cleanup.includes("method: 'DELETE'"));
  assert(cleanup.includes('limit = 5') && cleanup.includes('deletionAttempts >= deletionLimit'), 'Automatic orphan deletion must be bounded so the critical 5-minute Stremio job cannot drain an unlimited backlog in one run.');

  const reconcile = source('src/jellyfin/identity-reconciliation.js');
  assert(reconcile.includes("String(server.media_server_type || 'jellyfin').toLowerCase() === 'jellyfin'"), 'Identity reconciliation must not offer Jellyfin-specific repair actions for Emby servers.');
  assert(reconcile.includes("WHERE COALESCE(js.media_server_type,'jellyfin')='jellyfin'") && reconcile.includes("WHERE service_type='jellyfin'"), 'Candidate ownership and recovery evidence must stay provider-scoped.');
  assert(reconcile.includes("access?.free_state === accessState.ACCESS_STATES.ACTIVE_BLOCKED"), 'Blocked Free access must classify an unmanaged remote identity as an access leak.');
  assert(reconcile.includes("return 'free_access_repair'"), 'Missing Free access must not be offered the paid/primary link workflow.');
  assert(reconcile.includes('ACTIVE_BLOCKED'));
  assert(reconcile.includes('media.identity.canonical_policy_failed'));
  assert(reconcile.includes('ownershipPreserved: true'));
  assert(!reconcile.includes('canonical_replace_rolled_back'), 'Canonical ownership must not be rolled back after the replacement identity may have received access policy.');
  assert(reconcile.includes('This media identity has an active playback session'));
  assert(reconcile.includes('Media server session state could not be verified.'), 'Manual destructive reconciliation must fail closed when session state is malformed.');
  assert(reconcile.includes('This managed Stremio identity still belongs to an active entitlement and cannot be deleted.'), 'Manual deletion must protect active Stremio entitlement identities.');
  assert(reconcile.includes('Managed Stremio service identities cannot be linked as customer Jellyfin accounts.'), 'Internal Stremio identities must never be adopted as customer Jellyfin accounts.');
  assert(reconcile.includes('Managed Stremio service identities cannot become canonical customer Jellyfin accounts.'), 'Internal Stremio identities must never replace a canonical customer identity.');
  assert(reconcile.includes('userImport.getRemoteUser(serverId, old.jellyfinUserId)') && reconcile.includes('await assertStillUnmanaged(serverId, oldRemoteNow)'), 'Canonical replacement must re-read old remote identity and local ownership immediately before deleting it.');
  assert(reconcile.includes('AND lower(jellyfin_user_id)=lower($6)') && reconcile.includes('if (!adopted.rowCount)'), 'Concurrent canonical replacements must use compare-and-swap ownership so a stale request cannot overwrite a newer adoption.');
  assert(reconcile.includes('await provisioning.reconcileCustomer(customerId)'));

  const page = source('src/platform/admin-media-identity-reconciliation.js');
  assert(page.includes('/admin/servers/identity-reconciliation'));
  assert(page.includes('Compare live Jellyfin identities') && !page.includes('Jellyfin/Emby identities'), 'Admin copy must not imply unsupported Emby identity repair.');
  assert(page.includes('Free access needs repair') && page.includes('not linked as a paid/primary account'), 'Admin UI must keep Free repair separate from the primary-link action.');
  assert(page.includes('Confirm remote deletion'));
  assert(page.includes('Use this identity instead'));
  assert(page.includes('Invalid security token'));
  assert(page.includes('identityActionLimit'), 'Destructive identity reconciliation routes must be rate-limited.');

  const routes = source('src/platform/admin-route-composition.js');
  assert(routes.includes('createAdminMediaIdentityReconciliationRouter'));
  const nav = source('src/platform/admin-nav.js');
  assert(nav.includes("'media-identity-reconciliation'"));

  const capacity = source('src/jellyfin/user-capacity.js');
  assert(capacity.includes("ja.account_purpose='jellyfin'"), 'Stremio internal identities must not consume normal customer server capacity.');
})();

console.log('media identity reconciliation smoke: ok');
