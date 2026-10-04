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
})();

(function orphanContracts() {
  assert(orphanCleanup.INTERNAL_USER_RE.test('cf_stremio_1d25afae216c'));
  assert(orphanCleanup.INTERNAL_USER_RE.test('cf_stremio_1d25afae216c7585'));
  assert(!orphanCleanup.INTERNAL_USER_RE.test('cf_stremio_customer'));
  assert(!orphanCleanup.INTERNAL_USER_RE.test('normal-user'));

  const now = new Date('2026-10-04T12:00:00Z');
  assert.strictEqual(orphanCleanup.recentEnough({ LastActivityDate: '2026-10-04T11:00:00Z' }, 12, now), true);
  assert.strictEqual(orphanCleanup.recentEnough({ LastActivityDate: '2026-10-03T20:00:00Z' }, 12, now), false);
  assert.strictEqual(orphanCleanup.recentEnough({}, 12, now), false);
  assert.strictEqual(orphanCleanup.graceHours('0'), 1);
  assert.strictEqual(orphanCleanup.graceHours('999'), 168);
})();

(function integrationSurfaceContracts() {
  const jobs = source('src/automation/jobs.js');
  assert(jobs.includes("const stremioOrphanCleanup=require('../stremio/orphan-account-cleanup');"));
  assert(jobs.includes('const sync=await stremioManagedSweep.syncActiveBounded();const orphanApply=Number(sync.failed||0)===0;const orphans=await stremioOrphanCleanup.run({apply:orphanApply});'));

  const cleanup = source('src/stremio/orphan-account-cleanup.js');
  assert(cleanup.includes("account_purpose='stremio_internal'"));
  assert(cleanup.includes('jellyfin_account_creation_intents'));
  assert(cleanup.includes("'/Sessions'"));
  assert(!cleanup.includes("'/Sessions', { timeoutMs: 10000 }).catch(() => [])"), 'Destructive orphan cleanup must fail closed when session state is unavailable.');
  assert(cleanup.includes("status = 'provisioning_in_flight'"));
  assert(cleanup.includes("status = 'active_session'"));
  assert(cleanup.includes("status = 'recent_activity'"));
  assert(cleanup.includes("method: 'DELETE'"));

  const reconcile = source('src/jellyfin/identity-reconciliation.js');
  assert(reconcile.includes('ACTIVE_BLOCKED'));
  assert(reconcile.includes('media.identity.canonical_policy_failed'));
  assert(reconcile.includes('ownershipPreserved: true'));
  assert(!reconcile.includes('canonical_replace_rolled_back'), 'Canonical ownership must not be rolled back after the replacement identity may have received access policy.');
  assert(reconcile.includes('This media identity has an active playback session'));
  assert(reconcile.includes('await provisioning.reconcileCustomer(customerId)'));

  const page = source('src/platform/admin-media-identity-reconciliation.js');
  assert(page.includes('/admin/servers/identity-reconciliation'));
  assert(page.includes('Confirm remote deletion'));
  assert(page.includes('Use this identity instead'));
  assert(page.includes('Invalid security token'));

  const routes = source('src/platform/admin-route-composition.js');
  assert(routes.includes('createAdminMediaIdentityReconciliationRouter'));
  const nav = source('src/platform/admin-nav.js');
  assert(nav.includes("'media-identity-reconciliation'"));

  const capacity = source('src/jellyfin/user-capacity.js');
  assert(capacity.includes("ja.account_purpose='jellyfin'"), 'Stremio internal identities must not consume normal customer server capacity.');
})();

console.log('media identity reconciliation smoke: ok');
