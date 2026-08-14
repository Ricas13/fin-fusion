'use strict';

const assert = require('assert');
const registry = require('../src/jellyfin/registry');

const originalNodeEnv = process.env.NODE_ENV;
const originalAllowedHosts = process.env.JELLYFIN_ALLOWED_HOSTS;

try {
    process.env.NODE_ENV = 'production';
    delete process.env.JELLYFIN_ALLOWED_HOSTS;
    assert.throws(
        () => registry.normalizeBaseUrl('http://jellyfin.internal:8096'),
        /JELLYFIN_ALLOWED_HOSTS must be configured/
    );

    process.env.JELLYFIN_ALLOWED_HOSTS = 'jellyfin.internal, jellyfin-free.internal';
    assert.strictEqual(
        registry.normalizeBaseUrl('http://jellyfin.internal:8096/'),
        'http://jellyfin.internal:8096'
    );
    assert.strictEqual(
        registry.normalizeBaseUrl('https://jellyfin-free.internal/base/?ignored=true'),
        'https://jellyfin-free.internal/base'
    );
    assert.throws(
        () => registry.normalizeBaseUrl('http://127.0.0.1:8096'),
        /not on the production allowlist/
    );
    assert.throws(
        () => registry.normalizeBaseUrl('file:///etc/passwd'),
        /Only http and https Jellyfin URLs/
    );
    assert.throws(
        () => registry.normalizeBaseUrl('http://user:pass@jellyfin.internal:8096'),
        /may not contain credentials/
    );

    process.env.NODE_ENV = 'development';
    delete process.env.JELLYFIN_ALLOWED_HOSTS;
    assert.strictEqual(
        registry.normalizeBaseUrl('http://localhost:8096/'),
        'http://localhost:8096'
    );

    console.log('Jellyfin registry SSRF guard smoke test passed.');
} finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAllowedHosts === undefined) delete process.env.JELLYFIN_ALLOWED_HOSTS;
    else process.env.JELLYFIN_ALLOWED_HOSTS = originalAllowedHosts;
}
