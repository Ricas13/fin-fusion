'use strict';

// Real database: the integrity alert looks the customers up and hands the notification system a plain-language message
// (names, what to do, no raw ids). The dispatch itself is captured, nothing is sent.
require('dotenv').config();
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.SESSION_SECRET ||= 'integrity-alert-db-smoke-0123456789';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');
const { query } = require('../src/db');
const { runDbSmoke, unique } = require('./test-fixture');
const dispatchModule = require('../src/integrations/notification-dispatch');
const revenueIntegrity = require('../src/automation/revenue-integrity');

const created = { customers: [], users: [] };

runDbSmoke('integrity alert DB smoke', async () => {
    const realDispatch = dispatchModule.dispatch;
    const sent = [];
    dispatchModule.dispatch = async payload => { sent.push(payload); return { captured: true }; };
    try {
        const user = (await query(`INSERT INTO app_users(username,password_hash,role,active,email) VALUES($1,'x','customer',TRUE,$2) RETURNING id`, [unique('ia'), `${unique('ia')}@example.invalid`])).rows[0];
        created.users.push(user.id);
        const named = (await query(`INSERT INTO customers(display_name,email,user_id) VALUES('Alert Test Jane',$1,$2) RETURNING id`, [`${unique('jane')}@example.invalid`, user.id])).rows[0];
        const loginName = unique('loginonly');
        const user2 = (await query(`INSERT INTO app_users(username,password_hash,role,active,email) VALUES($1,'x','customer',TRUE,$2) RETURNING id`, [loginName, `${loginName}@example.invalid`])).rows[0];
        created.users.push(user2.id);
        const loginOnly = (await query(`INSERT INTO customers(display_name,email,user_id) VALUES('',NULL,$1) RETURNING id`, [user2.id])).rows[0];
        created.customers.push(named.id, loginOnly.id);

        const accountId = '45825a49-392c-4dd4-b5a0-d0d5b5f34ef2';
        const result = await revenueIntegrity.notify([
            { kind: 'primary_server_without_plan', id: accountId, customerId: named.id, detail: `Primary Jellyfin account ${accountId} exists without a live non-Free Jellyfin entitlement.` },
            { kind: 'stremio_active_without_effective_subscription', id: 'b6f434fe-6dd4-4ccb-95ac-91cc40825bac', customerId: loginOnly.id, detail: 'raw' },
            { kind: 'primary_server_without_plan', id: 'id-no-customer', customerId: '00000000-0000-4000-8000-000000000000', detail: 'raw' }
        ]);
        assert.deepStrictEqual(result, { captured: true });
        assert.strictEqual(sent.length, 1, 'one alert is sent');
        const alert = sent[0];
        assert.strictEqual(alert.eventType, 'automation.integrity.failed');
        assert(alert.adminText.includes('Alert Test Jane <') && alert.adminText.includes('@example.invalid>'), 'a real customer is named with their email');
        assert(alert.adminText.includes('What to do:'), 'the message says what to do');
        assert(!/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(alert.adminText.replace(/https?:\/\/\S+/g, '')), 'no raw ids in the message');
        assert(alert.adminText.includes('customer 00000000…'), 'a customer that no longer exists is shown by a short id, not an error');
        assert(alert.adminText.includes('ref 45825a49'), 'a short reference remains');
        assert.strictEqual(alert.subject, alert.adminSubject, 'email and chat use the same subject');
        assert(alert.subject.startsWith('Needs attention:'));
        assert.strictEqual(alert.templatePayload.count, 3, 'the structured payload keeps the findings for the email template');
        assert(/^[0-9a-f]{24}$/.test(alert.dedupeKey.split(':')[1]), 'dedupe key keeps its shape');
        // A customer with no display name or email on their own row falls back to their portal login.
        assert(alert.adminText.includes(loginName), 'a login-only customer is named by their portal login');
    } finally {
        dispatchModule.dispatch = realDispatch;
        await query(`DELETE FROM customers WHERE id=ANY($1::uuid[])`, [created.customers]).catch(() => {});
        await query(`DELETE FROM app_users WHERE id=ANY($1::uuid[])`, [created.users]).catch(() => {});
    }
});
