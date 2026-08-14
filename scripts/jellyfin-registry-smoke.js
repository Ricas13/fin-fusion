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

    console.log('Jellyfin registry URL validation smoke test passed.');
} finally {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
    if (originalAllowedHosts === undefined) delete process.env.JELLYFIN_ALLOWED_HOSTS;
    else process.env.JELLYFIN_ALLOWED_HOSTS = originalAllowedHosts;
}
