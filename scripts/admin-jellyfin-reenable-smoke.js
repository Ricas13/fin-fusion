'use strict';

const assert = require('assert');
const express = require('express');
const restore = require('../src/entitlements/jellyfin-inactivity-restore');
const provisioning = require('../src/jellyfin/resilient-provisioning');
const { createAdminJellyfinReenableRouter } = require('../src/platform/admin-jellyfin-reenable');
const view = require('../src/platform/customer-360-view');

const originalRestore = restore.restoreDisabledFreeAccess;
const originalReconcile = provisioning.reconcileCustomer;

(async () => {
    let call = null;
    restore.restoreDisabledFreeAccess = async (customerId, options) => {
        call = { customerId, actorUserId: options.actorUserId, reconcileType: typeof options.reconcile };
        return { restored: true, enabled: true, blocked: false, remainingHolds: [], stillDisabled: [] };
    };
    provisioning.reconcileCustomer = async () => ({ active: true });

    const app = express();
    app.use(express.urlencoded({ extended: false }));
    app.use((req, _res, next) => {
        req.session = {
            authUserId: '00000000-0000-0000-0000-000000000001',
            authRole: 'admin',
            adminId: '00000000-0000-0000-0000-000000000002',
            csrfToken: 'reenable-test-token'
        };
        next();
    });
    app.use(createAdminJellyfinReenableRouter());

    const server = await new Promise(resolve => {
        const instance = app.listen(0, '127.0.0.1', () => resolve(instance));
    });
    try {
        const address = server.address();
        const response = await fetch(`http://127.0.0.1:${address.port}/admin/users/00000000-0000-0000-0000-000000000003/jellyfin/re-enable`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ _csrf: 'reenable-test-token' })
        });
        assert.strictEqual(response.status, 302, 'mounted re-enable POST must redirect after a successful mutation');
        assert(call, 'mounted route must invoke the canonical restore owner');
        assert.strictEqual(call.customerId, '00000000-0000-0000-0000-000000000003');
        assert.strictEqual(call.actorUserId, '00000000-0000-0000-0000-000000000001');
        assert.strictEqual(call.reconcileType, 'function', 'route must pass the canonical Jellyfin reconciliation owner');
        assert((response.headers.get('location') || '').includes('Jellyfin%20access%20re-enabled'), 'success redirect must explain that access was re-enabled');

        const invalidCsrf = await fetch(`http://127.0.0.1:${address.port}/admin/users/00000000-0000-0000-0000-000000000003/jellyfin/re-enable`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ _csrf: 'wrong-token' })
        });
        assert.strictEqual(invalidCsrf.status, 403, 'mounted re-enable POST must reject invalid CSRF');

        const html = view.accessWorkspaceSection({
            customer: { id: '00000000-0000-0000-0000-000000000003' },
            primaryEntitlement: null,
            subscriptions: [{ status: 'active', plan_name: 'Free Server', service_type: 'jellyfin', is_free_tier: true, server_class: 'free' }],
            accounts: [{ id: 'a', disabled: true, account_purpose: 'jellyfin', server_name: 'Free Server', recon_status: 'successful' }]
        }, 'reenable-test-token', { currentPlan: null });
        assert(html.includes('Re-enable Jellyfin access'), 'disabled Free Server customer must get a visible re-enable action');
        assert(html.includes('Free Server · disabled'), 'disabled existing account must not be rendered as unassigned');
        assert(!html.includes('Create Jellyfin access'), 'disabled existing account must not be mistaken for an unprovisioned customer');
    } finally {
        restore.restoreDisabledFreeAccess = originalRestore;
        provisioning.reconcileCustomer = originalReconcile;
        await new Promise(resolve => server.close(resolve));
    }

    console.log('admin jellyfin re-enable mounted smoke: ok');
})().catch(error => {
    restore.restoreDisabledFreeAccess = originalRestore;
    provisioning.reconcileCustomer = originalReconcile;
    console.error(error);
    process.exit(1);
});
