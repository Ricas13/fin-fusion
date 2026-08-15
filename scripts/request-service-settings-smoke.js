'use strict';

const assert = require('assert');
process.env.DATA_ENCRYPTION_KEY = process.env.DATA_ENCRYPTION_KEY || '22'.repeat(32);

const { query } = require('../src/db');
const requestSettings = require('../src/integrations/request-service-settings');
const runtimeSettings = require('../src/platform/runtime-settings');
const outbound = require('../src/security/outbound-url-policy');

(async () => {
    const actor = null;
    const safeUrl='https://8.8.8.8/request-service';
    await query('DELETE FROM request_service_settings');
    await requestSettings.useEnvironment(actor);

    await assert.rejects(
        () => outbound.assertSafeIntegrationUrl('http://127.0.0.1:5055',{purpose:'Request service'}),
        /private address|loopback/,
        'request integration must reject untrusted loopback/private destinations'
    );
    const outboundCheck=await outbound.assertSafeIntegrationUrl(safeUrl,{purpose:'Request service'});
    assert.strictEqual(outboundCheck.private,false,'deterministic public test destination must pass outbound policy');

    const saved = await requestSettings.save({
        enabled: true,
        baseUrl: safeUrl+'/',
        apiKey: 'super-secret-test-key',
        syncIntervalMinutes: 12
    }, actor);
    assert.strictEqual(saved.configured, true);
    assert.strictEqual(saved.baseUrl, safeUrl);
    assert.strictEqual(saved.apiKeyConfigured, true);
    assert.strictEqual(saved.syncIntervalMinutes, 12);

    const row = await query('SELECT api_key_encrypted,base_url,enabled FROM request_service_settings WHERE id=1');
    assert.strictEqual(row.rowCount, 1);
    assert.strictEqual(row.rows[0].enabled, true);
    assert.strictEqual(row.rows[0].base_url, safeUrl);
    assert.ok(row.rows[0].api_key_encrypted);
    assert.ok(!row.rows[0].api_key_encrypted.includes('super-secret-test-key'));

    const cfg = await requestSettings.get();
    assert.strictEqual(cfg.apiKey, 'super-secret-test-key');
    assert.strictEqual(cfg.baseUrl, safeUrl);
    assert.strictEqual(requestSettings.syncIntervalMs(), 12 * 60 * 1000);
    assert.strictEqual(process.env.SEERR_API_KEY, 'super-secret-test-key');
    assert.strictEqual(Number(process.env.REQUEST_USER_SYNC_INTERVAL_MS), 12 * 60 * 1000);
    await runtimeSettings.reload();
    assert.strictEqual(runtimeSettings.overseerrUrl(), safeUrl);

    await requestSettings.save({
        enabled: false,
        baseUrl: safeUrl,
        apiKey: '',
        clearApiKey: true,
        syncIntervalMinutes: 15
    }, actor);
    const disabled = await requestSettings.status();
    assert.strictEqual(disabled.enabled, false);
    assert.strictEqual(disabled.configured, false);
    assert.strictEqual(disabled.apiKeyConfigured, false);
    assert.strictEqual(process.env.SEERR_API_KEY, '');

    console.log('request-service-settings-smoke: ok');
})().catch(error => {
    console.error(error);
    process.exit(1);
});
