'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const { dashboardRange, analyticsData, revenueFromEvent, revenueSummary } = require('../src/platform/admin-dashboard-analytics');
const { renderDashboard } = require('../src/platform/admin-dashboard-view');
const fs = require('fs');
const path = require('path');

async function seed() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const plan = (await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,allow_downloads,server_class,active,visible,sort_order)
        VALUES($1,'Dashboard Smoke','direct','month',30,600,'USD',3,TRUE,'premium',TRUE,TRUE,999)
        RETURNING id
    `, [`dashboard-smoke-${suffix}`])).rows[0];
    const customer = (await query(`
        INSERT INTO customers(display_name,email) VALUES('Dashboard Viewer',$1) RETURNING id
    `, [`dashboard-${suffix}@example.invalid`])).rows[0];
    const referred = (await query(`
        INSERT INTO customers(display_name,email) VALUES('Referred Viewer',$1) RETURNING id
    `, [`referred-${suffix}@example.invalid`])).rows[0];
    const server = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,health_status,priority)
        VALUES($1,$2,'premium','https://jellyfin.invalid','https://jellyfin.invalid','smoke-key',TRUE,'healthy',999)
        RETURNING id
    `, [`Dashboard ${suffix}`, `dashboard-${suffix}`])).rows[0];

    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days')
    `, [customer.id, plan.id]);
    await query(`
        INSERT INTO jellyfin_server_metrics(server_id,total_users,active_streams,managed_streams,transcode_streams,direct_stream_streams,direct_play_streams,paused_streams,observed_at)
        VALUES($1,42,7,2,1,2,4,0,NOW())
    `, [server.id]);
    await query(`
        INSERT INTO playback_history(server_id,customer_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES
        ($1,$2,$3,$4,'Smoke Movie','Movie','Living Room TV','Jellyfin Web','directplay',NOW()-INTERVAL '2 hours',NOW()-INTERVAL '1 hour',NOW()-INTERVAL '1 hour'),
        ($1,$2,$5,$6,'Smoke Series','Episode','Phone','Jellyfin Android','transcode',NOW()-INTERVAL '1 day 2 hours',NOW()-INTERVAL '1 day 1 hour',NOW()-INTERVAL '1 day 1 hour')
    `, [server.id, customer.id, `play-${suffix}-1`, `session-${suffix}-1`, `play-${suffix}-2`, `session-${suffix}-2`]);
    await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processed_at,created_at)
        VALUES('stripe',$1,'checkout.session.completed',$2::jsonb,NOW(),NOW()-INTERVAL '1 day')
    `, [`evt-${suffix}`, JSON.stringify({ data: { object: { mode: 'payment', payment_status: 'paid', amount_total: 600, currency: 'usd', customer_details: { email: `dashboard-${suffix}@example.invalid` } } } })]);
    await query(`INSERT INTO customer_provisioning_state(customer_id,status,last_error) VALUES($1,'blocked','smoke')`, [customer.id]);
    await query(`INSERT INTO request_user_sync(customer_id,status,last_error) VALUES($1,'failed','smoke')`, [customer.id]);
    const referral = (await query(`INSERT INTO referral_codes(customer_id,code) VALUES($1,$2) RETURNING id`, [customer.id, `REF${suffix}`])).rows[0];
    await query(`INSERT INTO referral_redemptions(referral_code_id,referred_customer_id,status,rewarded_at) VALUES($1,$2,'rewarded',NOW())`, [referral.id, referred.id]);
    return { suffix, plan, customer, referred, server };
}

async function main() {
    const fixedNow = new Date('2026-08-15T10:00:00.000Z');
    const range = dashboardRange({ range: '30d' }, fixedNow);
    assert.strictEqual(range.key, '30d');
    assert.strictEqual(range.bucket, 'day');
    const custom = dashboardRange({ range: 'custom', from: '2026-08-01', to: '2026-08-10' }, fixedNow);
    assert.strictEqual(custom.key, 'custom');
    assert.strictEqual(custom.days, 10);

    const stripe = revenueFromEvent({ provider: 'stripe', event_type: 'invoice.paid', payload: { data: { object: { amount_paid: 1234, currency: 'gbp' } } } });
    assert.deepStrictEqual({ minor: stripe.minor, currency: stripe.currency }, { minor: 1234, currency: 'GBP' });
    const paypal = revenueFromEvent({ provider: 'paypal', event_type: 'PAYMENT.CAPTURE.COMPLETED', payload: { resource: { amount: { value: '9.99', currency_code: 'USD' } } } });
    assert.deepStrictEqual({ minor: paypal.minor, currency: paypal.currency }, { minor: 999, currency: 'USD' });
    assert.strictEqual(revenueFromEvent({ provider: 'stripe', event_type: 'checkout.session.completed', payload: { data: { object: { mode: 'subscription', amount_total: 600 } } } }), null, 'subscription checkout must not double-count invoice revenue');

    const summary = revenueSummary([
        { provider: 'stripe', provider_event_id: 'a', event_type: 'invoice.paid', created_at: new Date('2026-08-14T10:00:00Z'), payload: { data: { object: { amount_paid: 600, currency: 'usd' } } } },
        { provider: 'stripe', provider_event_id: 'b', event_type: 'invoice.paid', created_at: new Date('2026-07-14T10:00:00Z'), payload: { data: { object: { amount_paid: 500, currency: 'usd' } } } }
    ], range, 'USD');
    assert.strictEqual(summary.totalMinor, 600);

    const seeded = await seed();
    const liveRange = dashboardRange({ range: '30d' }, new Date());
    const stats = await analyticsData(liveRange);
    assert(stats.current.jellyfinUsers >= 42, 'fleet Jellyfin users should include server metrics');
    assert(stats.current.fleetStreams >= 7, 'fleet streams should include unmanaged live streams');
    assert(stats.period.playbackSessions >= 2, 'managed playback history should aggregate');
    assert(stats.period.playbackSeconds >= 7000, 'watch duration should aggregate');
    assert(stats.period.revenueMinor >= 600, 'webhook-confirmed payment should aggregate as gross revenue');
    assert(stats.planMix.some(row => row.name === 'Dashboard Smoke'), 'active plan should appear in product usage');
    assert(stats.topStreamers.some(row => String(row.customer_id) === String(seeded.customer.id)), 'top streamers should include managed customer');
    assert(stats.topDevices.some(row => row.name === 'Living Room TV'), 'device analytics should aggregate');
    assert(stats.topContent.some(row => row.name === 'Smoke Movie'), 'content analytics should aggregate');
    assert(stats.topReferrers.some(row => String(row.customer_id) === String(seeded.customer.id)), 'referral analytics should aggregate');
    assert(Number(stats.operational.provisioning_problems) >= 1, 'provisioning alerts should use customer_provisioning_state');
    assert(Number(stats.operational.request_sync_problems) >= 1, 'request sync alerts should use request_user_sync');

    const html = renderDashboard({
        ...stats,
        setup: { configuredCount: 1, totalCount: 2 },
        options: {}
    });
    for (const needle of ['Gross revenue', 'Revenue history', 'Customer base over time', 'Managed streaming volume', 'Server load', 'Top streamers', 'Recent payments', 'Top referrers']) {
        assert(html.includes(needle), `dashboard should render ${needle}`);
    }
    assert(html.includes('range=365d'), 'dashboard should expose shared period presets');

    // The live /admin route no longer uses this file's own renderDashboard --
    // it now composes widgets through the registry-based admin-dashboard-main.js.
    // Keep asserting that wiring here so a future edit can't silently detach it.
    const dashboardSource = fs.readFileSync(path.join(__dirname, '..', 'src', 'platform', 'admin-dashboard.js'), 'utf8');
    assert(dashboardSource.includes("require('./admin-dashboard-main')"), 'the live dashboard route must render through admin-dashboard-main.js');

    console.log('admin analytics dashboard smoke: ok');
}

main().catch(error => {
    console.error(error);
    process.exitCode = 1;
}).finally(async () => {
    try { await getPool().end(); } catch (_) {}
});
