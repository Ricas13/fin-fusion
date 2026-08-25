'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin commerce dashboard smoke')) process.exit(0);

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/platform/admin-dashboard-registry');
const { buildContext, refundFromEvent } = require('../src/platform/admin-commerce-dashboard');
const { dashboardRange, fillSeries } = require('../src/platform/admin-dashboard-analytics');
const { normalizedDashboardMoney } = require('../src/platform/admin-dashboard-money');
const reportingCurrency = require('../src/platform/reporting-currency');

function fakeReq(adminId, queryParams = {}) {
    return { session: { authUserId: adminId, authRole: 'admin', adminId }, query: queryParams };
}

async function seedAdmin(suffix) {
    const inserted = await query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`, [`commerce-dashboard-${suffix}`]);
    return inserted.rows[0].id;
}

async function seedCommerceData(suffix) {
    const plan = (await query(`
        INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order)
        VALUES($1,'Commerce Dashboard Smoke','direct','jellyfin','month',30,1500,'USD',2,TRUE,TRUE,999) RETURNING id
    `, [`commerce-dashboard-smoke-${suffix}`])).rows[0];
    const customer = (await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Commerce Customer',$1,NOW()) RETURNING id`, [`commerce-widget-${suffix}@example.invalid`])).rows[0];
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,service_type_snapshot)
        VALUES($1,$2,'active','stripe',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days',$3,'jellyfin')
    `, [customer.id, plan.id, `sub_commerce_smoke_${suffix}`]);

    await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processed_at,created_at)
        VALUES($1,$2,'invoice.paid',$3::jsonb,NOW(),NOW()-INTERVAL '1 day')
    `, ['stripe', `evt_paid_${suffix}`, JSON.stringify({ data: { object: { amount_paid: 1500, currency: 'usd', customer_email: `payer-${suffix}@example.invalid` } } })]);
    await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processed_at,created_at)
        VALUES($1,$2,'charge.refunded',$3::jsonb,NOW(),NOW()-INTERVAL '1 day')
    `, ['stripe', `evt_refund_${suffix}`, JSON.stringify({ data: { object: { amount_refunded: 500, currency: 'usd' } } })]);
    await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processing_error,created_at)
        VALUES($1,$2,'invoice.payment_failed',$3::jsonb,'card_declined',NOW()-INTERVAL '1 day')
    `, ['stripe', `evt_failed_${suffix}`, JSON.stringify({ data: { object: {} } })]);

    await query(`
        INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,provider,checkout_mode,state,nonce_hash,expires_at,completed_at)
        VALUES('customer',$1,$2,'stripe','subscription','completed',$3,NOW()+INTERVAL '1 day',NOW())
    `, [customer.id, plan.id, `nonce-completed-${suffix}`]);
    await query(`
        INSERT INTO billing_checkout_intents(scope,customer_id,plan_id,provider,checkout_mode,state,nonce_hash,expires_at)
        VALUES('customer',$1,$2,'stripe','subscription','open',$3,NOW()+INTERVAL '1 day')
    `, [customer.id, plan.id, `nonce-open-${suffix}`]);

    await query(`
        INSERT INTO payment_incidents(provider,provider_event_id,incident_type,incident_status,customer_id,amount_minor,currency)
        VALUES('stripe',$1,'refund','open',$2,500,'USD')
    `, [`evt_refund_${suffix}`, customer.id]);

    return { customer, plan };
}

async function seedImportedOverlap(suffix) {
    const run = (await query(`
        INSERT INTO payment_history_import_runs(provider_scope,range_start,range_end,total_seen,imported_count,matched_count)
        VALUES('stripe','2099-01-01','2099-01-01',2,2,2) RETURNING id
    `)).rows[0];
    await query(`
        INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,fee_amount_minor,net_amount_minor,provider_customer_id,first_import_run_id,last_import_run_id)
        VALUES
          ('stripe',$1,'charge','available','2099-01-01T12:00:00Z','USD',1500,59,1441,$2,$3,$3),
          ('stripe',$4,'refund','available','2099-01-01T13:00:00Z','USD',-500,0,-500,$2,$3,$3)
    `, [`txn_history_charge_${suffix}`, `cus_history_${suffix}`, run.id, `txn_history_refund_${suffix}`]);
    await query(`
        INSERT INTO payment_events(provider,provider_event_id,event_type,payload,processed_at,created_at)
        VALUES
          ('stripe',$1,'invoice.paid',$2::jsonb,NOW(),'2099-01-01T12:00:00Z'),
          ('stripe',$3,'charge.refunded',$4::jsonb,NOW(),'2099-01-01T13:00:00Z')
    `, [
        `evt_history_paid_${suffix}`,
        JSON.stringify({ data: { object: { amount_paid: 1500, currency: 'usd', customer_email: `history-${suffix}@example.invalid` } } }),
        `evt_history_refund_${suffix}`,
        JSON.stringify({ data: { object: { amount_refunded: 500, currency: 'usd' } } })
    ]);
}

async function main() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const adminId = await seedAdmin(suffix);
    await seedCommerceData(suffix);

    const req = fakeReq(adminId);
    const ctx = await buildContext(req);
    for (const spec of registry.listWidgets('commerce')) {
        const html = await spec.render(ctx);
        assert(typeof html === 'string' && html.length > 0, `widget ${spec.key} must render non-empty HTML`);
    }

    // Gross/net revenue must reflect the seeded payment and refund after dashboard currency normalization.
    const expectedGrossMinor = reportingCurrency.convertMinor(1500, 'USD', ctx.data.revenue.primaryCurrency, ctx.reporting);
    const expectedRefundMinor = reportingCurrency.convertMinor(500, 'USD', ctx.data.revenue.primaryCurrency, ctx.reporting);
    assert(ctx.data.revenue.grossMinor >= expectedGrossMinor, 'gross revenue must include the seeded payment');
    assert(ctx.data.revenue.refundMinor >= expectedRefundMinor, 'refund total must include the seeded refund event');
    assert.strictEqual(ctx.data.revenue.netMinor, ctx.data.revenue.grossMinor - ctx.data.revenue.refundMinor, 'net revenue must equal gross minus refunds');
    assert(ctx.data.revenue.payingCustomers >= 1, 'paying-customer count must include the seeded payer email');

    // refundFromEvent must parse both provider payload shapes and ignore unrelated event types.
    assert.strictEqual(refundFromEvent({ provider: 'stripe', event_type: 'charge.refunded', payload: { data: { object: { amount_refunded: 500, currency: 'usd' } } } }).minor, 500);
    assert.strictEqual(refundFromEvent({ provider: 'paypal', event_type: 'PAYMENT.SALE.REFUNDED', payload: { resource: { amount: { total: '5.00', currency: 'USD' } } } }).minor, 500);
    assert.strictEqual(refundFromEvent({ provider: 'stripe', event_type: 'invoice.paid', payload: {} }), null);

    // Checkout funnel must reflect the real created-vs-completed intent counts.
    assert.strictEqual(ctx.data.funnel[0].label, 'Checkout started');
    assert(ctx.data.funnel[0].count >= 2, 'checkout funnel must count both seeded intents as started');
    assert(ctx.data.funnel[1].count >= 1, 'checkout funnel must count the completed intent');

    // Payment incident states must reflect the seeded open incident.
    assert(ctx.data.paymentStates.open >= 1, 'payment state breakdown must include the seeded open incident');

    // Imported provider history is authoritative inside its imported date coverage.
    // The matching webhook rows below deliberately describe the same money movement;
    // both Commerce and Main dashboard accounting must still count each movement once.
    await seedImportedOverlap(suffix);
    const historyReq = fakeReq(adminId, { range: 'custom', from: '2099-01-01', to: '2099-01-01' });
    const historyCtx = await buildContext(historyReq);
    const historyGross = reportingCurrency.convertMinor(1500, 'USD', historyCtx.data.revenue.primaryCurrency, historyCtx.reporting);
    const historyRefund = reportingCurrency.convertMinor(500, 'USD', historyCtx.data.revenue.primaryCurrency, historyCtx.reporting);
    assert.strictEqual(historyCtx.data.revenue.grossMinor, historyGross, 'Commerce gross revenue must prefer imported ledger coverage without double-counting webhook events');
    assert.strictEqual(historyCtx.data.revenue.refundMinor, historyRefund, 'Commerce refunds must prefer imported ledger coverage without double-counting webhook events');
    assert.strictEqual(historyCtx.data.revenue.netMinor, historyGross - historyRefund, 'Commerce net revenue must use imported payment and refund once each');
    assert.strictEqual(historyCtx.data.revenue.payingCustomers, 1, 'imported payer identity must contribute to paying-customer/ARPU calculations');

    const normalized = await normalizedDashboardMoney(historyCtx.range, fillSeries(historyCtx.range, [], []), historyCtx.reporting);
    assert.strictEqual(normalized.revenue.totalMinor, historyGross, 'Main dashboard revenue must include imported history without double-counting live webhook rows');
    assert.strictEqual(normalized.revenue.recent.length, 1, 'Main dashboard recent payments must expose the imported payment exactly once');
    assert.strictEqual(normalized.revenue.recent[0].source, 'history', 'Main dashboard should identify imported history as the accounting source inside covered dates');

    // No secret-shaped strings should ever end up in dashboard HTML output.
    for (const spec of registry.listWidgets('commerce')) {
        const html = (await spec.render(ctx)).toLowerCase();
        for (const banned of ['api_key', 'apikey', 'password_hash', 'session_secret', 'nonce_hash']) {
            assert(!html.includes(banned), `widget ${spec.key} must never include a ${banned}-shaped string`);
        }
    }

    // Rendering against a fresh (empty) database window must not crash.
    const emptyRange = dashboardRange({ range: '7d' }, new Date('2000-01-01T00:00:00.000Z'));
    const emptyCtx = { ...ctx, range: emptyRange };
    for (const spec of registry.listWidgets('commerce')) {
        await spec.render(emptyCtx);
    }

    console.log('admin commerce dashboard smoke: ok');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
