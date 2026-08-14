'use strict';

const assert = require('assert');
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

console.log('provisioning control smoke: ok');
