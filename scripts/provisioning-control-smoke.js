'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const control = require('../src/jellyfin/reconciliation-control');

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

const root = path.join(__dirname, '..');
const provisioning = fs.readFileSync(path.join(root, 'src/jellyfin/provisioning.js'), 'utf8');
const provisioningCore = fs.readFileSync(path.join(root, 'src/jellyfin/provisioning-core.js'), 'utf8');
const provisioningEngine = fs.readFileSync(path.join(root, 'src/jellyfin/provisioning-engine.js'), 'utf8');

assert(
    /module\.exports\s*=\s*require\(['"]\.\/provisioning['"]\)/.test(provisioningCore),
    'historical provisioning-core path must delegate directly to canonical provisioning facade'
);
assert(!/\basync\s+function\b/.test(provisioningCore), 'provisioning-core must not become a second implementation');
assert(provisioning.includes("require('./provisioning-engine')"), 'canonical provisioning facade must use the internal engine');
assert(!provisioning.includes("require('./provisioning-core')"), 'canonical provisioning facade must not depend on historical provisioning-core');
assert(provisioning.includes("require('../entitlements/access-holds')"), 'canonical provisioning must own typed access holds');
assert(provisioning.includes('inactivityHoldReconciliation.releaseObsoleteForCustomer'), 'canonical provisioning must release obsolete inactivity holds before reconciliation');
assert(provisioning.includes('service_extension_days=0'), 'canonical expiry must consume service-extension state');
assert(provisioning.includes('maybeAutoDowngrade'), 'canonical expiry must retain automatic free-tier downgrade behavior');
assert(provisioning.includes('markPasswordSetupRequired'), 'canonical provisioning must retain password-setup state for newly created Jellyfin users');
assert(provisioningEngine.includes('async function reconcileCustomer'), 'internal provisioning engine must retain low-level reconciliation mechanics');
assert(provisioningEngine.includes('async function createJellyfinAccount'), 'internal provisioning engine must retain Jellyfin account creation mechanics');

function jsFiles(dir) {
    const rows = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) rows.push(...jsFiles(full));
        else if (entry.isFile() && entry.name.endsWith('.js')) rows.push(full);
    }
    return rows;
}
const engineImporters = jsFiles(path.join(root, 'src'))
    .filter(file => fs.readFileSync(file, 'utf8').includes("require('./provisioning-engine')"))
    .map(file => path.relative(root, file).replace(/\\/g, '/'));
assert.deepStrictEqual(engineImporters, ['src/jellyfin/provisioning.js'], 'only the canonical provisioning facade may import the internal engine');

console.log('provisioning control smoke: ok');
