'use strict';

// The customer log reads auth_events and audit_log. Prove the real queries: right columns, scoped to THIS customer only,
// newest first, and the actor's name resolved.
require('dotenv').config();
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'customer-timeline-db-smoke-secret-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const { query } = require('../src/db');
const { runDbSmoke, unique } = require('./test-fixture');
const timeline = require('../src/platform/customer-360-timeline');
const manualSubscriptions = require('../src/entitlements/manual-subscriptions');

const created = { customers: [], users: [], plans: [], subscriptions: [] };

async function customerWithLogin(label) {
    const username = unique(`tl-${label}`);
    const user = (await query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','customer',TRUE) RETURNING id`, [username])).rows[0];
    created.users.push(user.id);
    const customer = (await query(`INSERT INTO customers(display_name,email,user_id) VALUES($1,$2,$3) RETURNING id`, [`Timeline ${label}`, `${username}@example.invalid`, user.id])).rows[0];
    created.customers.push(customer.id);
    return { customerId: customer.id, userId: user.id, username };
}

runDbSmoke('customer timeline DB smoke', async () => {
    try {
        const admin = (await query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`, [unique('tl-admin')])).rows[0];
        created.users.push(admin.id);
        const adminName = (await query('SELECT username FROM app_users WHERE id=$1', [admin.id])).rows[0].username;
        const a = await customerWithLogin('a');
        const b = await customerWithLogin('b');
        const lone = (await query(`INSERT INTO customers(display_name,email) VALUES('Timeline no login',$1) RETURNING id`, [`${unique('tl-lone')}@example.invalid`])).rows[0];
        created.customers.push(lone.id);

        await query(`INSERT INTO auth_events(user_id,identity_hint,event_type,success) VALUES($1,'a','login.session_created',TRUE),($1,'a','login.password_failed',FALSE),($2,'b','login.session_created',TRUE)`, [a.userId, b.userId]);
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.customer.ban','customer',$2,'{"reason":"test reason"}'::jsonb),($1,'admin.customer.unban','customer',$3,'{}'::jsonb)`, [admin.id, a.customerId, b.customerId]);

        const dataA = await timeline.load(a.customerId);
        assert.strictEqual(dataA.auth.length, 2, 'only this customer\'s sign-in events');
        assert(dataA.auth.every(row => row.event_type && 'success' in row && row.created_at), 'auth rows carry type, success and time');
        assert.strictEqual(dataA.audit.length, 1, 'only admin changes about this customer');
        assert.strictEqual(dataA.audit[0].actor_name, adminName, 'the administrator is named');
        assert.strictEqual(dataA.audit[0].metadata.reason, 'test reason');

        const dataB = await timeline.load(b.customerId);
        assert.strictEqual(dataB.auth.length, 1);
        assert.strictEqual(dataB.audit.length, 1);
        assert.strictEqual(dataB.audit[0].action, 'admin.customer.unban', 'customers never see each other\'s entries');

        const dataLone = await timeline.load(lone.id);
        assert.deepStrictEqual([dataLone.auth.length, dataLone.audit.length], [0, 0], 'a customer with no portal login and no history gets an empty (not failing) log');
        const nothing = await timeline.load('00000000-0000-4000-8000-000000000000');
        assert.deepStrictEqual([nothing.auth.length, nothing.audit.length], [0, 0], 'an unknown customer is empty, not an error');

        // Manual plan grants and outside refunds are audited against the SUBSCRIPTION, not the customer: they must still appear.
        const plan = (await query(`
            INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order)
            VALUES($1,'Timeline plan','direct','jellyfin','month',30,1000,'GBP',2,TRUE,TRUE,999) RETURNING id
        `, [unique('tl-plan')])).rows[0];
        created.plans.push(plan.id);
        const grantedToA = await manualSubscriptions.createManualSubscription({
            customerId: a.customerId, planId: plan.id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 86400000),
            actorUserId: admin.id, source: 'admin_grant', status: 'active', auditAction: 'admin.customer.manual_grant',
            auditMetadata: { note: 'paid by bank transfer' }
        });
        created.subscriptions.push(grantedToA.id);
        const grantedToB = await manualSubscriptions.createManualSubscription({
            customerId: b.customerId, planId: plan.id, startsAt: new Date(), endsAt: new Date(Date.now() + 30 * 86400000),
            actorUserId: admin.id, source: 'admin_grant', status: 'active', auditAction: 'admin.customer.manual_grant', auditMetadata: {}
        });
        created.subscriptions.push(grantedToB.id);
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.refund.recorded_externally_completed','subscription',$2,'{"reason":"refunded in Stripe"}'::jsonb)`, [admin.id, grantedToA.id]);

        const withSubs = await timeline.load(a.customerId);
        const actions = withSubs.audit.map(row => row.action).sort();
        assert.deepStrictEqual(actions, ['admin.customer.ban', 'admin.customer.manual_grant', 'billing.refund.recorded_externally_completed'], 'customer-scoped AND subscription-scoped admin events are both returned');
        const shown = timeline.build(withSubs).map(entry => entry.title);
        assert(shown.includes('Plan added manually') && shown.includes('Refund made outside the app was recorded') && shown.includes('Customer banned'), 'the grant and the outside refund appear in Admin changes');
        const grantDetail = timeline.build(withSubs).find(entry => entry.title === 'Plan added manually').detail;
        assert.strictEqual(grantDetail, `by ${adminName} · paid by bank transfer`, 'with the administrator and the note');
        const forB = await timeline.load(b.customerId);
        assert.deepStrictEqual(forB.audit.map(row => row.action).sort(), ['admin.customer.manual_grant', 'admin.customer.unban'], 'customer B sees only their own grant, never A\'s grant or refund');

        // A refund's completion row that falls OUTSIDE the newest-rows window must not cause a false "not finished".
        const sid = `sub-${unique('r')}`;
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata,created_at) VALUES
            ($1,'billing.refund.recorded_externally_completed','subscription',$2,$3::jsonb, NOW()-INTERVAL '30 days'),
            ($1,'billing.refund.recorded_externally','subscription',$2,$3::jsonb, NOW()-INTERVAL '1 day')`, [admin.id, grantedToA.id, JSON.stringify({ submissionId: sid })]);
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata,created_at)
            SELECT $1,'admin.customer.service.reconcile','subscription',$2,'{}'::jsonb, NOW()-INTERVAL '2 days'+(g||' seconds')::interval FROM generate_series(1,130) g`, [admin.id, grantedToA.id]);
        const wide = await timeline.load(a.customerId);
        assert(wide.audit.some(row => row.action === 'billing.refund.recorded_externally_completed' && row.metadata.submissionId === sid), 'the completion row outside the 120-row window was fetched directly');
        assert(!timeline.build(wide).some(entry => entry.title === 'Refund made outside the app is not finished'), 'so a finished refund is never shown as unfinished');
        // A genuinely unfinished one still is.
        const lost = `sub-${unique('lost')}`;
        await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'billing.refund.recorded_externally','subscription',$2,$3::jsonb)`, [admin.id, grantedToA.id, JSON.stringify({ submissionId: lost })]);
        assert.strictEqual(timeline.build(await timeline.load(a.customerId)).filter(entry => entry.title === 'Refund made outside the app is not finished').length, 1, 'a refund with no completion anywhere is still shown as not finished');

        const entries = timeline.build({ ...dataA });
        assert.deepStrictEqual(entries.map(entry => entry.title).sort(), ['Customer banned', 'Failed sign-in (wrong password)', 'Signed in to the portal'].sort());
        assert(entries.every(entry => entry.at), 'every entry has a time');
    } finally {
        await query(`DELETE FROM auth_events WHERE user_id=ANY($1::uuid[])`, [created.users]).catch(() => {});
        await query(`DELETE FROM subscriptions WHERE id=ANY($1::uuid[])`, [created.subscriptions]).catch(() => {});
        await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
        await query(`DELETE FROM plans WHERE id=ANY($1::uuid[])`, [created.plans]).catch(() => {});
        // audit_log is append-only and references users with ON DELETE SET NULL, so the test admin/users are left in place
        // (disposable test database); nothing here can be deleted without breaking the append-only guarantee.
    }
});
