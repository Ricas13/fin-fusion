'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/platform/admin-dashboard-registry');
const { buildContext } = require('../src/platform/admin-users-dashboard');
const { dashboardRange } = require('../src/platform/admin-dashboard-analytics');

function fakeReq(adminId, queryParams = {}) {
    return { session: { authUserId: adminId, authRole: 'admin', adminId }, query: queryParams };
}

async function seedAdmin(suffix) {
    const inserted = await query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`, [`users-dashboard-${suffix}`]);
    return inserted.rows[0].id;
}

async function seedUsersData(suffix) {
    const plan = (await query(`
        INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order)
        VALUES($1,'Users Dashboard Smoke','direct','jellyfin','month',30,999,'USD',1,TRUE,TRUE,999) RETURNING id
    `, [`users-dashboard-smoke-${suffix}`])).rows[0];
    const server = (await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,health_status,priority)
        VALUES($1,$2,'premium','https://jellyfin.invalid','https://jellyfin.invalid','smoke-key',TRUE,'healthy',999)
        RETURNING id
    `, [`Users Dashboard ${suffix}`, `users-dashboard-${suffix}`])).rows[0];
    const customer = (await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Streaming Customer',$1,NOW()-INTERVAL '10 days') RETURNING id`, [`users-widget-${suffix}@example.invalid`])).rows[0];
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,service_type_snapshot)
        VALUES($1,$2,'active','stripe',NOW()-INTERVAL '5 days',NOW()+INTERVAL '5 days',$3,'jellyfin')
    `, [customer.id, plan.id, `sub_users_smoke_${suffix}`]);
    await query(`
        INSERT INTO playback_history(server_id,customer_id,playback_key,jellyfin_session_id,item_name,item_type,device_name,client_name,playback_method,started_at,last_seen_at,ended_at)
        VALUES($1,$2,$3,$4,'Smoke Movie','Movie','Living Room TV','Jellyfin Web','directplay',NOW()-INTERVAL '10 minutes',NOW(),NULL)
    `, [server.id, customer.id, `users-play-${suffix}`, `users-session-${suffix}`]);
    return { customer, plan };
}

async function main() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const adminId = await seedAdmin(suffix);
    await seedUsersData(suffix);

    const req = fakeReq(adminId);
    const ctx = await buildContext(req);
    for (const spec of registry.listWidgets('users')) {
        const html = await spec.render(ctx);
        assert(typeof html === 'string' && html.length > 0, `widget ${spec.key} must render non-empty HTML`);
    }

    // Stream-limit utilization must reflect the seeded live session against the plan's limit.
    assert(ctx.data.utilization.some(row => Number(row.live_streams) >= 1), 'utilization must include the seeded live stream');

    // The lifecycle funnel must only ever expose the 3 stages CAPTAiNFiN can compute reliably.
    assert.strictEqual(ctx.data.funnel.length, 3, 'lifecycle funnel must have exactly 3 stages');
    assert.deepStrictEqual(ctx.data.funnel.map(stage => stage.label), ['Signed up', 'Activated a subscription', 'Active now']);

    // No secret-shaped strings should ever end up in dashboard HTML output.
    for (const spec of registry.listWidgets('users')) {
        const html = (await spec.render(ctx)).toLowerCase();
        for (const banned of ['api_key', 'apikey', 'password_hash', 'session_secret', 'jellyfin_session_id']) {
            assert(!html.includes(banned), `widget ${spec.key} must never include a ${banned}-shaped string`);
        }
    }

    // Rendering against a fresh (empty) database window must not crash.
    const emptyRange = dashboardRange({ range: '7d' }, new Date('2000-01-01T00:00:00.000Z'));
    const emptyCtx = { ...ctx, range: emptyRange };
    for (const spec of registry.listWidgets('users')) {
        await spec.render(emptyCtx);
    }

    console.log('admin users dashboard smoke: ok');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
