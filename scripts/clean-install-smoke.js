'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const { setupReadiness } = require('../src/platform/setup-readiness');

(async () => {
    const expectClean = String(process.env.CLEAN_INSTALL_EXPECTED || 'true') === 'true';
    const counts = await query(`
        SELECT
            (SELECT COUNT(*)::int FROM plans) AS plans,
            (SELECT COUNT(*)::int FROM jellyfin_servers) AS servers,
            (SELECT COUNT(*)::int FROM customers) AS customers,
            (SELECT COUNT(*)::int FROM resellers) AS resellers,
            (SELECT COUNT(*)::int FROM subscriptions) AS subscriptions,
            (SELECT COUNT(*)::int FROM plan_provider_prices) AS provider_mappings
    `);
    const row = counts.rows[0];
    const settings = await query(`
        SELECT setting_key,setting_value FROM platform_settings
        WHERE setting_key IN ('platform','installation','storefront','storefront_features','referral_program')
    `);
    const map = Object.fromEntries(settings.rows.map(item => [item.setting_key, item.setting_value]));

    if (expectClean) {
        assert.strictEqual(Number(row.plans), 0, 'fresh install must not seed commercial/trial plans');
        assert.strictEqual(Number(row.servers), 0, 'fresh install must not seed Jellyfin servers');
        assert.strictEqual(Number(row.customers), 0, 'fresh install must not seed customers');
        assert.strictEqual(Number(row.resellers), 0, 'fresh install must not seed resellers');
        assert.strictEqual(Number(row.subscriptions), 0, 'fresh install must not seed subscriptions');
        assert.strictEqual(Number(row.provider_mappings), 0, 'fresh install must not seed payment mappings');
        assert.strictEqual(map.platform?.storefrontEnabled, false, 'fresh storefront must be disabled');
        assert.strictEqual(map.platform?.publicRegistration, false, 'fresh public registration must be disabled');
        assert.strictEqual(map.referral_program?.enabled, false, 'fresh referrals must be disabled');
        assert.strictEqual(map.installation?.cleanInstall, true, 'fresh install marker must be recorded');
        assert.strictEqual(map.storefront, undefined, 'fresh install must not carry seeded marketing copy');
        assert.strictEqual(map.storefront_features, undefined, 'fresh install must not carry seeded feature copy');

        const readiness = await setupReadiness();
        assert.strictEqual(readiness.cleanInstall, true);
        assert.strictEqual(readiness.counts.plans, 0);
        assert.strictEqual(readiness.counts.servers, 0);
        assert.strictEqual(readiness.totalCount, 6);
        assert(readiness.checklist.find(item => item.key === 'jellyfin' && !item.configured));
        assert(readiness.checklist.find(item => item.key === 'plans' && !item.configured));
        console.log('clean install smoke: ok');
    } else {
        // A database that already contained an application/legacy table before
        // migration must NOT be treated as a fresh install. This protects live
        // upgrades from the fresh-only cleanup in migration 025.
        const legacyPlans = await query(`
            SELECT COUNT(*)::int AS count FROM plans
            WHERE code IN ('trial-24h','monthly','six-month','yearly')
        `);
        assert.strictEqual(Number(legacyPlans.rows[0].count), 4, 'upgrade simulation must preserve historical seeded plans');
        assert.strictEqual(map.installation, undefined, 'upgrade simulation must not receive a fresh-install marker');
        console.log('upgrade preservation smoke: ok');
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
