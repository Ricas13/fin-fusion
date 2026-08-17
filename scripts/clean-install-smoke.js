'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const { setupReadiness } = require('../src/platform/setup-readiness');

(async () => {
    const expectedAdmins = Number.parseInt(process.env.CLEAN_INSTALL_EXPECT_ADMINS || '1', 10);
    const cleanExpected = String(process.env.CLEAN_INSTALL_EXPECTED || '').toLowerCase() === 'true';
    const settings = await query(`SELECT setting_key, setting_value FROM platform_settings`);
    const map = Object.fromEntries(settings.rows.map(row => [row.setting_key, row.setting_value]));
    const admins = await query(`SELECT COUNT(*)::int AS count FROM app_users WHERE role='admin'`);
    assert.strictEqual(Number(admins.rows[0].count), expectedAdmins, `expected ${expectedAdmins} admin(s)`);

    if (cleanExpected) {
        const counts = await query(`SELECT
            (SELECT COUNT(*)::int FROM customers) customers,
            (SELECT COUNT(*)::int FROM jellyfin_servers) servers,
            (SELECT COUNT(*)::int FROM subscriptions) subscriptions,
            (SELECT COUNT(*)::int FROM plans WHERE is_free_tier=TRUE) free_tiers,
            (SELECT COUNT(*)::int FROM plans) plans`);
        assert.strictEqual(Number(counts.rows[0].customers), 0, 'fresh install must not seed customers');
        assert.strictEqual(Number(counts.rows[0].servers), 0, 'fresh install must not seed Jellyfin servers');
        assert.strictEqual(Number(counts.rows[0].subscriptions), 0, 'fresh install must not seed subscriptions');
        assert.strictEqual(Number(counts.rows[0].plans), 1, 'fresh install must contain only the permanent free tier');
        assert.strictEqual(Number(counts.rows[0].free_tiers), 1, 'fresh install must contain exactly one permanent free tier');

        if (expectedAdmins > 0) {
            const admin = await query(`SELECT password_changed_at FROM app_users WHERE role='admin' ORDER BY created_at LIMIT 1`);
            assert(admin.rows[0]?.password_changed_at, 'native administrator password timestamp missing');
        }

        assert.strictEqual(map.platform?.storefrontEnabled, false, 'fresh storefront must be disabled');
        assert.strictEqual(map.platform?.publicRegistration, false, 'fresh public registration must be disabled');
        assert.strictEqual(map.affiliate_program?.enabled, false, 'fresh affiliate programme must be disabled');
        assert.strictEqual(map.installation?.cleanInstall, true, 'fresh install marker must be recorded');
        assert.strictEqual(map.storefront, undefined, 'fresh install must not carry seeded marketing copy');
        assert.strictEqual(map.storefront_features, undefined, 'fresh install must not carry seeded feature copy');

        const readiness = await setupReadiness();
        assert.strictEqual(readiness.cleanInstall, true);
        assert.strictEqual(readiness.counts.plans, 1, 'setup readiness must count the permanent free tier');
        assert.strictEqual(readiness.counts.freeTiers, 1, 'setup readiness must recognise exactly one permanent free tier');
        assert.strictEqual(readiness.counts.configuredCustomerPlans, 0, 'system-created Free Access must not make the customer catalogue look configured');
        assert.strictEqual(readiness.counts.servers, 0);
        assert.strictEqual(readiness.counts.affiliates, 0, 'fresh install must have no affiliate accounts');
        assert.strictEqual(readiness.totalCount, 9, 'setup readiness checklist contract changed; update clean-install expectations intentionally');
        assert(readiness.checklist.find(item => item.key === 'jellyfin' && !item.configured));
        assert(readiness.checklist.find(item => item.key === 'plans' && !item.configured && /Free Access/.test(item.detail)));
        assert(readiness.checklist.find(item => item.key === 'direct-payments' && !item.configured));
        assert(readiness.checklist.find(item => item.key === 'affiliates' && !item.configured));
        assert(!readiness.checklist.some(item => /reseller/i.test(item.key) || /reseller/i.test(item.label)), 'retired reseller setup must not return');
        assert(readiness.checklist.find(item => item.key === 'requests' && !item.configured));
        assert(readiness.checklist.find(item => item.key === 'email' && !item.configured));
        assert(readiness.checklist.find(item => item.key === 'automation' && !item.configured));
        console.log(`clean install smoke: ok (admins=${expectedAdmins})`);
    } else {
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