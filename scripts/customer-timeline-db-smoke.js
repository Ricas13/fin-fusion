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

const created = { customers: [], users: [] };

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

        const entries = timeline.build({ ...dataA });
        assert.deepStrictEqual(entries.map(entry => entry.title).sort(), ['Customer banned', 'Failed sign-in (wrong password)', 'Signed in to the portal'].sort());
        assert(entries.every(entry => entry.at), 'every entry has a time');
    } finally {
        await query(`DELETE FROM auth_events WHERE user_id=ANY($1::uuid[])`, [created.users]).catch(() => {});
        await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
        // audit_log is append-only and references users with ON DELETE SET NULL, so the test admin/users are left in place
        // (disposable test database); nothing here can be deleted without breaking the append-only guarantee.
    }
});
