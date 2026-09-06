'use strict';

const assert = require('assert');
const outbound = require('../src/security/outbound-url-policy');
const registry = require('../src/jellyfin/registry');

function response(status, payload) {
    return {
        status,
        ok: status >= 200 && status < 300,
        text: async () => payload == null ? '' : JSON.stringify(payload)
    };
}

async function expectCode(promise, code) {
    let caught = null;
    try { await promise; } catch (error) { caught = error; }
    assert(caught, `Expected ${code} error`);
    assert.strictEqual(caught.code, code);
    return caught;
}

(async () => {
    const originalSafeFetch = outbound.safeFetch;
    const server = {
        id: 'server-1',
        name: 'Premium',
        media_server_type: 'jellyfin',
        base_url: 'https://jellyfin.example.test',
        apiKey: 'test-api-key'
    };

    try {
        const calls = [];
        outbound.safeFetch = async (url, options) => {
            calls.push({ url: String(url), options });
            return response(200, { Id: 'admin-user', Policy: { IsAdministrator: true } });
        };
        const protectedError = await expectCode(
            registry.assertJellyfinAdministratorProtected(server, '/Users/admin-user/Policy', 'POST', 10000),
            'JELLYFIN_ADMIN_PROTECTED'
        );
        assert.strictEqual(protectedError.retryable, false);
        assert.strictEqual(protectedError.jellyfinUserId, 'admin-user');
        assert.strictEqual(calls.length, 1, 'Protection must perform exactly one read-only identity check');
        assert.strictEqual(calls[0].options.method, 'GET');
        assert.match(calls[0].url, /\/Users\/admin-user$/);

        outbound.safeFetch = async () => response(200, { Id: 'customer-user', Policy: { IsAdministrator: false } });
        await registry.assertJellyfinAdministratorProtected(server, '/Users/customer-user/Password', 'POST', 10000);

        outbound.safeFetch = async () => response(500, { error: 'server failure' });
        const lookupError = await expectCode(
            registry.assertJellyfinAdministratorProtected(server, '/Users/customer-user', 'DELETE', 10000),
            'JELLYFIN_ADMIN_PROTECTION_CHECK_FAILED'
        );
        assert.strictEqual(lookupError.status, 500);

        outbound.safeFetch = async () => response(404, { error: 'not found' });
        await registry.assertJellyfinAdministratorProtected(server, '/Users/already-gone', 'DELETE', 10000);

        let embyLookup = false;
        outbound.safeFetch = async () => { embyLookup = true; return response(200, {}); };
        await registry.assertJellyfinAdministratorProtected({ ...server, media_server_type: 'emby' }, '/Users/u1', 'DELETE', 10000);
        assert.strictEqual(embyLookup, false, 'Jellyfin administrator protection must not alter Emby behavior');

        console.log('Jellyfin administrator mutation protection runtime smoke test passed.');
    } finally {
        outbound.safeFetch = originalSafeFetch;
    }
})().catch(error => {
    console.error(error);
    process.exitCode = 1;
});
