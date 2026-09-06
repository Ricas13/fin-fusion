'use strict';

const assert = require('assert');
const fs = require('fs');
const express = require('express');
const restore = require('../src/entitlements/jellyfin-inactivity-restore');
const provisioning = require('../src/jellyfin/resilient-provisioning');
const { createAdminJellyfinReenableRouter } = require('../src/platform/admin-jellyfin-reenable');

const permanentAccessSource = fs.readFileSync('src/entitlements/permanent-access.js', 'utf8');
assert(permanentAccessSource.includes("type:'inactivity_policy'"), 'returning Free Server permanent access to automation must release the stale inactivity hold');
assert(permanentAccessSource.includes('Free Server returned to automation; start a fresh inactivity observation window'), 'Free Server hold release must record why the old inactivity episode was closed');
assert(permanentAccessSource.indexOf("type:'inactivity_policy'") < permanentAccessSource.indexOf('permanent_access=FALSE'), 'the stale inactivity hold must be released before permanent access is revoked and reconciliation can remove the account');

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
        assert.strictEqual(response.status, 302, 'mounted Free Server restore POST must redirect after a successful mutation');
        assert(call, 'mounted route must invoke the canonical restore owner');
        assert.strictEqual(call.customerId, '00000000-0000-0000-0000-000000000003');
        assert.strictEqual(call.actorUserId, '00000000-0000-0000-0000-000000000001');
        assert.strictEqual(call.reconcileType, 'function', 'route must pass the canonical Jellyfin reconciliation owner');
        assert((response.headers.get('location') || '').includes('Free%20Server%20access%20restored'), 'success redirect must explain that Free access was restored by reprovisioning');

        const invalidCsrf = await fetch(`http://127.0.0.1:${address.port}/admin/users/00000000-0000-0000-0000-000000000003/jellyfin/re-enable`, {
            method: 'POST',
            redirect: 'manual',
            headers: { 'content-type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({ _csrf: 'wrong-token' })
        });
        assert.strictEqual(invalidCsrf.status, 403, 'mounted restore POST must reject invalid CSRF');
    } finally {
        restore.restoreDisabledFreeAccess = originalRestore;
        provisioning.reconcileCustomer = originalReconcile;
        await new Promise(resolve => server.close(resolve));
    }

    console.log('admin jellyfin Free Server restore mounted smoke: ok');
})().catch(error => {
    restore.restoreDisabledFreeAccess = originalRestore;
    provisioning.reconcileCustomer = originalReconcile;
    console.error(error);
    process.exit(1);
});
