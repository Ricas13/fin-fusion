'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const transfer = require('../src/platform/configuration-transfer');

async function server(slug, name) {
    const result = await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority,max_users,health_status)
        VALUES($1,$2,'premium',$3,$3,'test-not-a-real-secret',TRUE,100,100,'healthy')
        RETURNING id
    `, [name, slug, `https://${slug}.example.test`]);
    return result.rows[0].id;
}

(async () => {
    const serverA = await server('premium-a', 'Premium A');
    const serverB = await server('premium-b', 'Premium B');

    await query(`
        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES('platform',$1::jsonb)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value
    `, [JSON.stringify({
        siteName: 'Portable Source',
        storefrontEnabled: false,
        publicRegistration: false,
        requireEmailVerification: false,
        requireAdminTwoFactor: true,
        entitlementJobIntervalMs: 300000,
        serverHealthIntervalMs: 300000,
        overseerrUrl: ''
    })]);

    await query(`
        INSERT INTO notification_preferences(event_type,telegram_enabled,email_enabled)
        VALUES('customer.created',TRUE,FALSE)
        ON CONFLICT(event_type) DO UPDATE SET telegram_enabled=TRUE,email_enabled=FALSE
    `);

    const plan = await query(`
        INSERT INTO plans(
            code,name,description,audience,billing_interval,duration_days,price_minor,currency,streams,
            allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,allow_live_tv_management,
            allow_4k,allow_remuxing,allow_remote_access,server_class,active,visible,sort_order,
            library_access_mode,library_names,placement_strategy
        ) VALUES(
            'portable-monthly','Portable Monthly','Portable plan','direct','month',30,600,'USD',3,
            TRUE,FALSE,TRUE,TRUE,FALSE,TRUE,FALSE,TRUE,'premium',TRUE,TRUE,10,
            'include',ARRAY['Movies','TV'],'weighted'
        ) RETURNING id
    `);
    const planId = plan.rows[0].id;
    await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,70)', [planId, serverA]);

    await query(`
        INSERT INTO reseller_tiers(
            code,name,description,monthly_price_minor,currency,seat_limit,grace_days,sort_order,visible,active,
            server_class,streams,allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,
            allow_live_tv,allow_live_tv_management,allow_remote_access,allow_4k,
            library_access_mode,library_names,placement_strategy,capacity_limit
        ) VALUES(
            'portable-reseller','Portable Reseller','Portable managed-user plan',5000,'GBP',20,3,15,TRUE,TRUE,
            'premium',5,TRUE,FALSE,TRUE,TRUE,FALSE,FALSE,TRUE,FALSE,
            'include',ARRAY['Movies 1080p','TV 1080p'],'least_users',25
        )
    `);

    const exported = await transfer.exportPortableConfiguration();
    assert.strictEqual(exported.format, transfer.FORMAT);
    assert.strictEqual(exported.version, 2);
    assert(Array.isArray(exported.configuration.resellerTiers), 'v2 export must include reseller tiers');
    assert(Array.isArray(exported.configuration.directPaymentMappings), 'v2 export must include direct payment mappings');
    assert(Array.isArray(exported.configuration.automation), 'v2 export must include automation settings');
    const freePlan = exported.configuration.plans.find(item => item.is_free_tier === true || item.code === 'free-access');
    const portablePlan = exported.configuration.plans.find(item => item.code === 'portable-monthly');
    const portableTier = exported.configuration.resellerTiers.find(item => item.code === 'portable-reseller');
    assert(freePlan, 'portable configuration must include the permanent free tier');
    assert(portablePlan, 'portable configuration must include the configured customer plan');
    assert(portableTier, 'portable configuration must include the reseller plan');
    assert.strictEqual(portablePlan.serverPool[0].serverSlug, 'premium-a');
    assert.strictEqual(Number(portableTier.seat_limit), 20);
    assert.strictEqual(Number(portableTier.streams), 5, 'reseller concurrent-stream policy must export');
    assert.strictEqual(portableTier.allow_video_transcoding, false, 'reseller transcode policy must export');
    assert.deepStrictEqual(portableTier.library_names, ['Movies 1080p','TV 1080p'], 'reseller library policy must export');
    assert.strictEqual(exported.configuration.settings.platform.requireAdminTwoFactor, undefined, 'security policy must not be portable');

    // Keep a regression for the documented V1 compatibility path as V2 becomes canonical.
    const legacy = {
        format: exported.format,
        version: 1,
        configuration: {
            settings: { platform: exported.configuration.settings.platform },
            plans: exported.configuration.plans,
            notifications: exported.configuration.notifications
        },
        excluded: exported.excluded
    };
    assert.strictEqual(transfer.parseDocument(legacy).version, 1, 'v1 portable documents must remain importable');

    const serialized = JSON.stringify(exported);
    for (const forbidden of ['test-not-a-real-secret', 'base_url', 'api_key_encrypted', 'provider_subscription_id', 'reseller_credit_cost', 'reseller_trial_credit_cost']) {
        assert(!serialized.includes(forbidden), `portable export leaked forbidden field/value ${forbidden}`);
    }

    exported.configuration.settings.platform.siteName = 'Portable Target';
    portablePlan.name = 'Portable Monthly Updated';
    portablePlan.price_minor = 750;
    portablePlan.serverPool = [{ serverSlug: 'premium-b', weight: 250 }];
    portableTier.streams = 4;
    portableTier.allow_downloads = false;
    portableTier.library_access_mode = 'include';
    portableTier.library_names = ['Movies 1080p'];
    portableTier.capacity_limit = 30;
    exported.configuration.plans.push({
        ...portablePlan,
        code: 'portable-trial',
        name: 'Portable Trial',
        billing_interval: 'trial',
        duration_days: 1,
        price_minor: 0,
        streams: 1,
        is_free_tier: false,
        serverPool: [{ serverSlug: 'not-present', weight: 100 }]
    });

    const preview = await transfer.previewImport(exported);
    assert.strictEqual(preview.summary.plansCreate, 1);
    assert(preview.summary.plansUpdate >= 1, 'portable customer plan update must be detected');
    assert.strictEqual(preview.summary.serverPoolsApply, 1);
    assert.strictEqual(preview.summary.serverPoolsSkipped, 1);
    assert(preview.warnings.some(w => w.includes('not-present')));

    const applied = await transfer.applyImport(exported, null);
    assert.strictEqual(applied.summary.poolsApplied, 1);
    assert.strictEqual(applied.summary.poolsSkipped, 1);
    assert.strictEqual(applied.summary.atomic, true, 'portable import must commit as one atomic transaction');
    assert.strictEqual(applied.summary.version, 2, 'portable import summary must preserve document version');

    const updatedPlan = await query("SELECT id,name,price_minor FROM plans WHERE code='portable-monthly'");
    assert.strictEqual(updatedPlan.rows[0].name, 'Portable Monthly Updated');
    assert.strictEqual(Number(updatedPlan.rows[0].price_minor), 750);
    const updatedPool = await query(`
        SELECT js.slug,pse.weight FROM plan_server_eligibility pse
        JOIN jellyfin_servers js ON js.id=pse.server_id
        WHERE pse.plan_id=$1
    `, [updatedPlan.rows[0].id]);
    assert.deepStrictEqual(updatedPool.rows.map(row => [row.slug, Number(row.weight)]), [['premium-b', 250]]);

    const updatedTier = await query(`
        SELECT streams,allow_downloads,allow_video_transcoding,library_access_mode,library_names,capacity_limit
        FROM reseller_tiers WHERE code='portable-reseller'
    `);
    assert.strictEqual(Number(updatedTier.rows[0].streams), 4, 'reseller stream policy must round-trip');
    assert.strictEqual(updatedTier.rows[0].allow_downloads, false, 'reseller download policy must round-trip');
    assert.strictEqual(updatedTier.rows[0].allow_video_transcoding, false, 'reseller transcode policy must round-trip');
    assert.strictEqual(updatedTier.rows[0].library_access_mode, 'include');
    assert.deepStrictEqual(updatedTier.rows[0].library_names, ['Movies 1080p'], 'reseller library policy must round-trip');
    assert.strictEqual(Number(updatedTier.rows[0].capacity_limit), 30, 'reseller storefront capacity must round-trip');

    const trialPool = await query(`
        SELECT COUNT(*)::int AS count FROM plan_server_eligibility pse
        JOIN plans p ON p.id=pse.plan_id WHERE p.code='portable-trial'
    `);
    assert.strictEqual(Number(trialPool.rows[0].count), 0, 'missing target server must not be guessed');

    const permanentFree = await query("SELECT is_free_tier,active,visible,price_minor FROM plans WHERE is_free_tier=TRUE");
    assert.strictEqual(permanentFree.rowCount, 1, 'configuration import must preserve exactly one permanent free tier');
    assert.strictEqual(permanentFree.rows[0].active, true);
    assert.strictEqual(permanentFree.rows[0].visible, true);
    assert.strictEqual(Number(permanentFree.rows[0].price_minor), 0);

    const platform = await query("SELECT setting_value FROM platform_settings WHERE setting_key='platform'");
    assert.strictEqual(platform.rows[0].setting_value.siteName, 'Portable Target');
    assert.strictEqual(platform.rows[0].setting_value.requireAdminTwoFactor, true, 'non-portable security setting must survive merge import');

    const audit = await query("SELECT metadata FROM audit_log WHERE action='admin.configuration.import.atomic' ORDER BY id DESC LIMIT 1");
    assert.strictEqual(audit.rowCount, 1, 'portable import must emit its atomic audit event');
    assert.strictEqual(Number(audit.rows[0].metadata.version), 2, 'atomic import audit must record the imported document version');
    assert.strictEqual(audit.rows[0].metadata.atomic, true, 'atomic import audit must record transaction semantics');
    assert(Object.prototype.hasOwnProperty.call(audit.rows[0].metadata, 'automationJobs'), 'atomic import audit must include the v2 preview summary');

    const bad = JSON.parse(JSON.stringify(exported));
    const badPortable = bad.configuration.plans.find(item => item.code === 'portable-monthly');
    badPortable.streams = 0;
    assert.throws(() => transfer.parseDocument(bad), /between 1 and 50/);

    console.log('configuration transfer smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
