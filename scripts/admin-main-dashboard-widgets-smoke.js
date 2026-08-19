'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/platform/admin-dashboard-registry');
const { renderMain, buildContext } = require('../src/platform/admin-dashboard-main');
const { dashboardRange } = require('../src/platform/admin-dashboard-analytics');

function fakeReq(adminId, queryParams = {}) {
    return { session: { authUserId: adminId, authRole: 'admin', adminId }, query: queryParams };
}

async function seedAdmin(suffix) {
    const inserted = await query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`, [`main-dashboard-${suffix}`]);
    return inserted.rows[0].id;
}

async function seedBusinessData(suffix) {
    const plan = (await query(`
        INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order)
        VALUES($1,'Main Dashboard Smoke','direct','jellyfin','month',30,999,'USD',3,TRUE,TRUE,999) RETURNING id
    `, [`main-dashboard-smoke-${suffix}`])).rows[0];
    const customer = (await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Widget Customer',$1,NOW()) RETURNING id`, [`widget-${suffix}@example.invalid`])).rows[0];
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,service_type_snapshot)
        VALUES($1,$2,'active','stripe',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days',$3,'jellyfin')
    `, [customer.id, plan.id, `sub_smoke_${suffix}`]);
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,updated_at)
        VALUES($1,$2,'cancelled','manual',NOW()-INTERVAL '20 days',NOW()-INTERVAL '1 days',NOW()-INTERVAL '1 days')
    `, [customer.id, plan.id]);
    return { customer, plan };
}

async function main() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const adminId = await seedAdmin(suffix);
    await seedBusinessData(suffix);

    // Every registered Main widget must render without throwing, both against
    // real seeded data and against a request with no saved layout.
    const req = fakeReq(adminId);
    const ctx = await buildContext(req);
    for (const spec of registry.listWidgets('main')) {
        const html = await spec.render(ctx);
        assert(typeof html === 'string' && html.length > 0, `widget ${spec.key} must render non-empty HTML`);
    }

    // MRR must be a real, non-fabricated number derived from actual subscription rows.
    assert(ctx.data.mrr.amountMinor > 0, 'MRR must reflect the seeded recurring subscription');
    assert(ctx.data.mrr.subscriptions >= 1, 'MRR subscription count must include the seeded row');

    // Churn rate must be a real ratio, not a placeholder.
    assert(ctx.data.churn.activeAtStart >= 0);
    assert(ctx.data.churn.cancelledCount >= 1, 'seeded cancelled subscription must be counted');

    const { html } = await renderMain(req);
    assert(html.includes('data-dashboard-key="main"'), 'rendered page must expose the widget-drag root');
    assert(html.includes('data-widget-key='), 'rendered page must include at least one widget');
    assert(html.includes('data-csrf-token='), 'rendered page must embed a CSRF token for the drag/save script');
    assert(html.includes('/js/admin-dashboard-widgets.js'), 'rendered page must load the drag/customize client script');

    // No secret-shaped strings should ever end up in dashboard HTML output.
    const lower = html.toLowerCase();
    for (const banned of ['api_key', 'apikey', 'password_hash', 'session_secret']) {
        assert(!lower.includes(banned), `dashboard HTML must never include a ${banned}-shaped string`);
    }

    // Rendering against a fresh (empty) database must not crash: use a range
    // far in the past with nothing seeded in it.
    const emptyRange = dashboardRange({ range: '7d' }, new Date('2000-01-01T00:00:00.000Z'));
    const emptyCtx = { ...ctx, range: emptyRange, data: { ...ctx.data, range: emptyRange } };
    for (const spec of registry.listWidgets('main')) {
        await spec.render(emptyCtx);
    }

    console.log('admin main dashboard widgets smoke: ok');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
