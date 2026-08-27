'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const control = require('../src/jellyfin/reconciliation-control');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');
const adminProvisioning=read('src/platform/admin-provisioning.js');
const stremioRequeue=read('db/migrations/031_requeue_legacy_stremio_provisioning.sql');
const reconciliationLock=read('src/jellyfin/reconciliation-lock.js');
const resilientProvisioning=read('src/jellyfin/resilient-provisioning.js');
const provisioningFacade=read('src/jellyfin/provisioning.js');

const desired = {
    IsAdministrator: false,
    IsHidden: true,
    IsDisabled: false,
    EnableAllDevices: true,
    EnableAllFolders: false,
    EnabledFolders: ['b', 'a'],
    EnableAllChannels: false,
    EnableRemoteAccess: true,
    EnableMediaPlayback: true,
    EnableAudioPlaybackTranscoding: true,
    EnableVideoPlaybackTranscoding: false,
    EnablePlaybackRemuxing: true,
    EnableContentDownloading: true,
    EnableSyncTranscoding: false,
    EnableMediaConversion: false,
    EnableContentDeletion: false,
    EnableRemoteControlOfOtherUsers: false,
    EnableSharedDeviceControl: false,
    EnableLiveTvManagement: false,
    EnableLiveTvAccess: true,
    EnableUserPreferenceAccess: true,
    AuthenticationProviderId: 'auth',
    PasswordResetProviderId: 'reset',
    SyncPlayAccess: 'None'
};

const remote = { Policy: { ...desired, EnabledFolders: ['a', 'b'], ExtraJellyfinField: true } };
assert.strictEqual(control.policyMatches(remote, desired), true, 'irrelevant Jellyfin fields and folder order should not create drift');
assert.strictEqual(control.policyHash(remote), control.policyHash(desired), 'policy hash should be stable across normalized representations');
assert.strictEqual(control.policyMatches({ Policy: { ...desired, EnableContentDownloading: false } }, desired), false, 'meaningful policy drift must be detected');

assert.strictEqual(control.retryDelayMinutes(1), 1);
assert.strictEqual(control.retryDelayMinutes(2), 2);
assert.strictEqual(control.retryDelayMinutes(3), 5);
assert.strictEqual(control.retryDelayMinutes(4), 10);
assert.strictEqual(control.retryDelayMinutes(5), 30);
assert.strictEqual(control.retryDelayMinutes(6), 60);
assert.strictEqual(control.retryDelayMinutes(99), 60);

assert.strictEqual(control.classifyError(new Error('No eligible Jellyfin server is currently available for plan monthly')).status, 'blocked');
assert.strictEqual(control.classifyError(new Error('Missing on server: Movies')).status, 'blocked');
assert.strictEqual(control.classifyError(new Error('Jellyfin returned HTTP 503')).status, 'failed');

const now = Date.now();
assert.strictEqual(control.verificationFresh(new Date(now - 1000), now), true);
assert.strictEqual(control.verificationFresh(new Date(now - control.VERIFY_INTERVAL_MS - 1), now), false);

assert(reconciliationLock.includes('pg_try_advisory_lock')&&reconciliationLock.includes('pg_advisory_unlock'),'customer reconciliation must use a PostgreSQL advisory lock that works across app and automation processes');
assert(reconciliationLock.includes('while the first reconcile was already in progress')&&!reconciliationLock.includes('const inFlight = new Map()'),'queued reconciliation calls must run again after prior state-changing work instead of coalescing onto a stale result');
assert(reconciliationLock.includes("CUSTOMER_RECONCILIATION_LOCK_TIMEOUT"),'reconciliation lock contention must fail with an explicit retryable error');
assert(/async function reconcileCustomer\(customerId\)\{return reconciliationLock\.withCustomerReconciliationLock/.test(resilientProvisioning),'resilient multi-lane reconciliation must serialize per customer');
assert(/async function reconcileCustomer\(customerId\)\{return reconciliationLock\.withCustomerReconciliationLock/.test(provisioningFacade),'legacy provisioning facade must serialize direct reconciliation callers too');
assert(provisioningFacade.includes('reconciliationLock.withCustomerReconciliationLock(customerId,async()=>{await syncAccess(customerId);return core.reconcileAccount(accountId);})'),'account-scoped reconciliation must share the same customer lock');

assert(adminProvisioning.includes('p.service_type'),'provisioning control room must load the effective plan service type');
assert(adminProvisioning.includes("serviceType(row)==='stremio'?'Stremio':'Jellyfin'"),'provisioning labels must distinguish Stremio from Jellyfin');
assert(adminProvisioning.includes("'Stremio delivery':'Jellyfin access'"),'provisioning issue titles must describe the actual service being repaired');
assert(adminProvisioning.includes('Customer Jellyfin login not required'),'Stremio-only delivery must not imply that the customer needs Jellyfin credentials');
assert(adminProvisioning.includes('retired Stremio delivery model'),'legacy Stremio failure text must be translated into current operator guidance');
assert(!adminProvisioning.includes('paid and active customers actually have the Jellyfin access'),'provisioning overview must not remain Jellyfin-only');
assert(stremioRequeue.includes('customer_provisioning_state')&&stremioRequeue.includes("p.service_type='stremio'"),'deployment migration must target only active Stremio provisioning state');
assert(stremioRequeue.includes("status='pending'")&&stremioRequeue.includes('next_attempt_at=NOW()'),'obsolete Stremio delivery failures must be requeued for the current reconciler');
assert(stremioRequeue.includes('Active Stremio entitlement requires either selected shared sources or a managed Jellyfin delivery identity'),'migration must narrowly target the retired failure signature');

console.log('provisioning control smoke: ok');
