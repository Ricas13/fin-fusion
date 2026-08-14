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
            reseller_credit_cost,reseller_trial_credit_cost,library_access_mode,library_names,placement_strategy
        ) VALUES(
            'portable-monthly','Portable Monthly','Portable plan','both','month',30,600,'USD',3,
            TRUE,FALSE,TRUE,TRUE,FALSE,TRUE,FALSE,TRUE,'premium',TRUE,TRUE,10,1,NULL,'include',ARRAY['Movies','TV'],'weighted'
        ) RETURNING id
    `);
    const planId = plan.rows[0].id;
    await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,70)', [planId, serverA]);

    const exported = await transfer.exportPortableConfiguration();
    assert.strictEqual(exported.format, transfer.FORMAT);
    assert.strictEqual(exported.version, 1);
    assert.strictEqual(exported.configuration.plans.length, 1);
    assert.strictEqual(exported.configuration.plans[0].serverPool[0].serverSlug, 'premium-a');
    assert.strictEqual(exported.configuration.settings.platform.requireAdminTwoFactor, undefined, 'security policy must not be portable');

    const serialized = JSON.stringify(exported);
    for (const forbidden of ['test-not-a-real-secret', 'base_url', 'api_key_encrypted', 'provider_subscription_id']) {
        assert(!serialized.includes(forbidden), `portable export leaked forbidden field/value ${forbidden}`);
    }

    exported.configuration.settings.platform.siteName = 'Portable Target';
    exported.configuration.plans[0].name = 'Portable Monthly Updated';
    exported.configuration.plans[0].price_minor = 750;
    exported.configuration.plans[0].serverPool = [{ serverSlug: 'premium-b', weight: 250 }];
    exported.configuration.plans.push({
        ...exported.configuration.plans[0],
        code: 'portable-trial',
        name: 'Portable Trial',
        billing_interval: 'trial',
        duration_days: 1,
        price_minor: 0,
        streams: 1,
        serverPool: [{ serverSlug: 'not-present', weight: 100 }]
    });

    const preview = await transfer.previewImport(exported);
    assert.strictEqual(preview.summary.plansCreate, 1);
    assert.strictEqual(preview.summary.plansUpdate, 1);
    assert.strictEqual(preview.summary.serverPoolsApply, 1);
    assert.strictEqual(preview.summary.serverPoolsSkipped, 1);
    assert(preview.warnings.some(w => w.includes('not-present')));

    const applied = await transfer.applyImport(exported, null);
    assert.strictEqual(applied.summary.poolsApplied, 1);
    assert.strictEqual(applied.summary.poolsSkipped, 1);

    const updatedPlan = await query("SELECT id,name,price_minor FROM plans WHERE code='portable-monthly'");
    assert.strictEqual(updatedPlan.rows[0].name, 'Portable Monthly Updated');
    assert.strictEqual(Number(updatedPlan.rows[0].price_minor), 750);
    const updatedPool = await query(`
        SELECT js.slug,pse.weight FROM plan_server_eligibility pse
        JOIN jellyfin_servers js ON js.id=pse.server_id
        WHERE pse.plan_id=$1
    `, [updatedPlan.rows[0].id]);
    assert.deepStrictEqual(updatedPool.rows.map(row => [row.slug, Number(row.weight)]), [['premium-b', 250]]);

    const trialPool = await query(`
        SELECT COUNT(*)::int AS count FROM plan_server_eligibility pse
        JOIN plans p ON p.id=pse.plan_id WHERE p.code='portable-trial'
    `);
    assert.strictEqual(Number(trialPool.rows[0].count), 0, 'missing target server must not be guessed');

    const platform = await query("SELECT setting_value FROM platform_settings WHERE setting_key='platform'");
    assert.strictEqual(platform.rows[0].setting_value.siteName, 'Portable Target');
    assert.strictEqual(platform.rows[0].setting_value.requireAdminTwoFactor, true, 'non-portable security setting must survive merge import');

    const audit = await query("SELECT metadata FROM audit_log WHERE action='admin.configuration.import' ORDER BY id DESC LIMIT 1");
    assert.strictEqual(audit.rowCount, 1);
    assert.strictEqual(audit.rows[0].metadata.version, 1);

    const bad = JSON.parse(JSON.stringify(exported));
    bad.configuration.plans[0].streams = 0;
    assert.throws(() => transfer.parseDocument(bad), /between 1 and 50/);

    console.log('configuration transfer smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
