'use strict';

const assert = require('assert');
const registry = require('../src/jellyfin/registry');

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
        /Only http and https Jellyfin URLs/
    );
    assert.throws(
        () => registry.normalizeBaseUrl('http://user:pass@jellyfin.internal:8096'),
        /may not contain credentials/
    );

    const token = '1234567890abcdef1234567890abcdef';
    const headers = registry.authHeaders(token);
    assert.strictEqual(headers.Authorization, `MediaBrowser Token="${token}"`);
    assert.strictEqual(headers.Accept, 'application/json');
    assert.strictEqual(headers['X-Emby-Token'], undefined, 'Deprecated X-Emby-Token header must not be used');
    assert.strictEqual(registry.authHeaders(token, { jsonBody: true })['Content-Type'], 'application/json');

    console.log('Jellyfin registry URL/auth validation smoke test passed.');
} finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAllowedHosts === undefined) delete process.env.JELLYFIN_ALLOWED_HOSTS;
    else process.env.JELLYFIN_ALLOWED_HOSTS = originalAllowedHosts;
}
