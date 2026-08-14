'use strict';

const assert = require('assert');
const { query } = require('../src/db');
const requestSettings = require('../src/integrations/request-service-settings');

(async () => {
    const actor = null;
    await query('DELETE FROM request_service_settings');
    await requestSettings.useEnvironment(actor);

    const saved = await requestSettings.save({
        enabled: true,
        baseUrl: 'https://requests.example.test/',
        apiKey: 'super-secret-test-key',
        syncIntervalMinutes: 12
    }, actor);
    assert.strictEqual(saved.configured, true);
    assert.strictEqual(saved.baseUrl, 'https://requests.example.test');
    assert.strictEqual(saved.apiKeyConfigured, true);
    assert.strictEqual(saved.syncIntervalMinutes, 12);

    const row = await query('SELECT api_key_encrypted,base_url,enabled FROM request_service_settings WHERE id=1');
    assert.strictEqual(row.rowCount, 1);
    assert.strictEqual(row.rows[0].enabled, true);
    assert.strictEqual(row.rows[0].base_url, 'https://requests.example.test');
    assert.ok(row.rows[0].api_key_encrypted);
    assert.ok(!row.rows[0].api_key_encrypted.includes('super-secret-test-key'));

    const cfg = await requestSettings.get();
    assert.strictEqual(cfg.apiKey, 'super-secret-test-key');
    assert.strictEqual(cfg.baseUrl, 'https://requests.example.test');
    assert.strictEqual(requestSettings.syncIntervalMs(), 12 * 60 * 1000);

    await requestSettings.save({
        enabled: false,
        baseUrl: 'https://requests.example.test',
        apiKey: '',
        clearApiKey: true,
        syncIntervalMinutes: 15
    }, actor);
    const disabled = await requestSettings.status();
    assert.strictEqual(disabled.enabled, false);
    assert.strictEqual(disabled.configured, false);
    assert.strictEqual(disabled.apiKeyConfigured, false);

    console.log('request-service-settings-smoke: ok');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
