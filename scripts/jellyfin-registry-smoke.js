'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registry = require('../src/jellyfin/registry');
const fleetMetrics = require('../src/jellyfin/fleet-metrics');
const scopedInactivity = require('../src/automation/customer-inactivity-scoped');

const originalNodeEnv = process.env.NODE_ENV;
const originalAllowedHosts = process.env.JELLYFIN_ALLOWED_HOSTS;

try {
    process.env.NODE_ENV = 'production';
    delete process.env.JELLYFIN_ALLOWED_HOSTS;

    assert.strictEqual(
        registry.normalizeBaseUrl('http://jellyfin.internal:8096/'),
        'http://jellyfin.internal:8096'
    );
    assert.strictEqual(
        registry.normalizeBaseUrl('https://jellyfin-free.internal/base/?ignored=true'),
        'https://jellyfin-free.internal/base'
    );
    assert.strictEqual(
        registry.normalizeBaseUrl('http://127.0.0.1:8096/'),
        'http://127.0.0.1:8096'
    );
    assert.throws(
        () => registry.normalizeBaseUrl('file:///etc/passwd'),
        /Only http and https media-server URLs/
    );
    assert.throws(
        () => registry.normalizeBaseUrl('http://user:pass@jellyfin.internal:8096'),
        /may not contain credentials/
    );

    const token = '1234567890abcdef1234567890abcdef';
    const headers = registry.authHeaders(token);
    assert.strictEqual(headers.Authorization, `MediaBrowser Token="${token}"`);
    assert.strictEqual(headers.Accept, 'application/json');
    assert.strictEqual(headers['X-Emby-Token'], undefined, 'Jellyfin requests must retain the MediaBrowser Authorization header');
    assert.strictEqual(registry.authHeaders(token, { jsonBody: true })['Content-Type'], 'application/json');

    const embyHeaders = registry.authHeaders(token, { mediaServerType:'emby', jsonBody:true });
    assert.strictEqual(embyHeaders['X-Emby-Token'], token, 'Emby server-to-server requests must use X-Emby-Token');
    assert.strictEqual(embyHeaders.Authorization, undefined, 'Emby adapter must not inherit the Jellyfin Authorization header');
    assert.strictEqual(embyHeaders['Content-Type'], 'application/json');
    assert.strictEqual(registry.mediaProvider.apiPath('emby', '/Users'), '/emby/Users');
    assert.strictEqual(registry.mediaProvider.apiPath('emby', '/emby/Users'), '/emby/Users');
    assert.strictEqual(registry.mediaProvider.apiPath('jellyfin', '/Users'), '/Users');
    assert.strictEqual(registry.mediaProvider.healthEndpoint('emby'), '/System/Info');
    assert.strictEqual(registry.mediaProvider.healthEndpoint('jellyfin'), '/System/Info/Public');
    assert.strictEqual(registry.mediaProvider.normalizeType(undefined), 'jellyfin', 'legacy rows must default to Jellyfin semantics');
    assert.throws(() => registry.mediaProvider.normalizeType('plex'), /Unsupported media server type/);

    const jellyfinPolicy = {
        IsAdministrator:false,
        IsDisabled:false,
        EnableRemoteAccess:true,
        AuthenticationProviderId:'Jellyfin.Server.Implementations.Users.DefaultAuthenticationProvider',
        PasswordResetProviderId:'Jellyfin.Server.Implementations.Users.DefaultPasswordResetProvider'
    };
    assert.strictEqual(
        registry.mediaProvider.requestBody('jellyfin', '/Users/u1/Policy', jellyfinPolicy),
        jellyfinPolicy,
        'Jellyfin user policy must remain byte-shape compatible'
    );
    const embyPolicy = registry.mediaProvider.requestBody('emby', '/Users/u1/Policy', jellyfinPolicy);
    assert.strictEqual(embyPolicy.AuthenticationProviderId, undefined, 'Emby policy must not receive Jellyfin authentication provider IDs');
    assert.strictEqual(embyPolicy.PasswordResetProviderId, undefined, 'Emby policy must not receive Jellyfin password-reset provider IDs');
    assert.strictEqual(embyPolicy.EnableRemoteAccess, true, 'Shared entitlement policy fields must survive Emby adaptation');
    assert.strictEqual(jellyfinPolicy.AuthenticationProviderId.includes('Jellyfin.Server'), true, 'Provider adaptation must not mutate the caller-owned policy object');
    const createBody = { Name:'compat-user', Password:'secret' };
    assert.strictEqual(registry.mediaProvider.requestBody('emby', '/Users/New', createBody), createBody, 'Compatible non-policy request bodies must pass through unchanged');
    assert.deepStrictEqual(
        registry.mediaProvider.requestBody('emby', '/emby/Users/u1/Policy', jellyfinPolicy),
        embyPolicy,
        'Policy adaptation must also recognize already-prefixed Emby paths'
    );

    // Jellyfin /Users activity is the authoritative freshness signal for managed
    // accounts. LastActivityDate wins, with LastLoginDate as the compatibility
    // fallback used by older/less active Jellyfin records. Emby exposes the same
    // MediaBrowser activity fields, so the higher-level freshness logic remains
    // provider-neutral.
    const preferred = fleetMetrics.userActivityDate({
        LastActivityDate: '2026-08-26T21:30:00.000Z',
        LastLoginDate: '2026-08-20T10:00:00.000Z'
    });
    assert.strictEqual(preferred.toISOString(), '2026-08-26T21:30:00.000Z');
    const fallback = fleetMetrics.userActivityDate({
        LastActivityDate: 'not-a-date',
        LastLoginDate: '2026-08-25T12:00:00.000Z'
    });
    assert.strictEqual(fallback.toISOString(), '2026-08-25T12:00:00.000Z');
    assert.strictEqual(
        fleetMetrics.isNewerActivity('2026-08-26T12:00:00.000Z', '2026-08-25T12:00:00.000Z'),
        false,
        'An older media-server timestamp must never regress stored account activity'
    );
    assert.strictEqual(
        fleetMetrics.isNewerActivity('2026-08-25T12:00:00.000Z', '2026-08-26T12:00:00.000Z'),
        true
    );

    const root = path.join(__dirname, '..');
    const fleetSource = fs.readFileSync(path.join(root, 'src/jellyfin/fleet-metrics.js'), 'utf8');
    const inactivitySource = fs.readFileSync(path.join(root, 'src/automation/customer-inactivity-scoped.js'), 'utf8');
    const jobsSource = fs.readFileSync(path.join(root, 'src/automation/jobs.js'), 'utf8');
    assert(
        fleetSource.includes('incoming.activity_at > ja.last_activity_at'),
        'Fleet activity persistence must keep a monotonic last_activity_at guard'
    );
    assert(
        fleetSource.includes("registry.request(serverId, '/Users'") && fleetSource.includes('await persistUserActivity(serverId, users)'),
        'The regular fleet poll must refresh managed media-server user activity from /Users'
    );
    assert(
        jobsSource.includes("require('./customer-inactivity-scoped')"),
        'Automation must use server-scoped inactivity safety checks'
    );
    assert(
        inactivitySource.indexOf('refreshCandidateServers(discovered)') < inactivitySource.indexOf('await base.candidates(globalCfg) : discovered'),
        'Inactivity enforcement must refresh target media-server activity before its final candidate decision'
    );

    const rows = [
        { server_id: 'free-server', eligible: true, customer_id: 'free-customer' },
        { server_id: 'unrelated-offline', eligible: true, customer_id: 'other-customer' },
        { server_id: 'free-server', eligible: false, customer_id: 'active-customer' }
    ];
    const safeRows = scopedInactivity.eligibleOnReadyServers(rows, {
        'free-server': { ready: true },
        'unrelated-offline': { ready: false, error: 'offline' }
    });
    assert.deepStrictEqual(
        safeRows.map(row => row.customer_id),
        ['free-customer'],
        'An unrelated offline server must not block eligible users on a healthy target server'
    );
    assert.deepStrictEqual(
        scopedInactivity.eligibleOnReadyServers([{ server_id: 'free-server', eligible: true }], {
            'free-server': { ready: false, error: 'activity unavailable' }
        }),
        [],
        'If the target Free Server activity refresh fails, enforcement must fail safe for that server'
    );

    console.log('Jellyfin/Emby registry URL/auth/activity validation smoke test passed.');
} finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAllowedHosts === undefined) delete process.env.JELLYFIN_ALLOWED_HOSTS;
    else process.env.JELLYFIN_ALLOWED_HOSTS = originalAllowedHosts;
}
