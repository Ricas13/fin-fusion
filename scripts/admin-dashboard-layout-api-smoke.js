'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin dashboard layout API smoke')) process.exit(0);

// Exercises the real admin-dashboard-layout JSON API end to end over HTTP
// (auth gating, dashboard-key validation, CSRF, response schema, no leaked
// secret fields) using a minimal self-contained Express harness: real
// session middleware (in-memory store, independent of the app's production
// Postgres-backed session store) plus a test-only login route that sets the
// same session fields the real staff-login flow sets after authenticating.

const assert = require('assert');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { query, getPool } = require('../src/db');
const registry = require('../src/platform/admin-dashboard-registry');
const csrf = require('../src/auth/csrf');
const { createAdminDashboardLayoutRouter } = require('../src/platform/admin-dashboard-layout');

registry.register('main', 'apiSmokeWidget', { title: 'API Smoke', defaultOrder: 1, defaultSpan: 6, render: async () => '<p>x</p>' });

function jar() {
    let cookie = '';
    return {
        headers() { return cookie ? { cookie } : {}; },
        capture(res) {
            const setCookie = res.headers.get('set-cookie');
            if (setCookie) cookie = setCookie.split(';')[0];
        }
    };
}

async function main() {
    const suffix = crypto.randomBytes(5).toString('hex');
    const admin = (await query(
        `INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`,
        [`dashboard-api-${suffix}`]
    )).rows[0];

    const app = express();
    app.use(express.json());
    app.use(session({ secret: 'test-harness-secret-not-used-in-production', resave: false, saveUninitialized: false }));
    app.post('/test-login', (req, res) => {
        req.session.authUserId = admin.id;
        req.session.authRole = 'admin';
        req.session.adminId = admin.id;
        return res.json({ csrfToken: csrf.token(req) });
    });
    app.use(createAdminDashboardLayoutRouter());
    const server = await new Promise((resolve, reject) => {
        const s = app.listen(0, () => resolve(s));
        s.on('error', reject);
    });
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const cookies = jar();

    try {
        // Unauthenticated request must be rejected, not silently succeed.
        const unauth = await fetch(`${base}/admin/api/dashboard/main/layout`);
        assert.strictEqual(unauth.status, 401, 'unauthenticated layout request must be rejected');
        const unauthBody = await unauth.json();
        assert.strictEqual(unauthBody.ok, false, 'unauthenticated response must report ok:false');

        // "Log in."
        const login = await fetch(`${base}/test-login`, { method: 'POST' });
        cookies.capture(login);
        const { csrfToken } = await login.json();

        // Unknown dashboard key must 404, not fall through to a default dashboard.
        const unknown = await fetch(`${base}/admin/api/dashboard/bogus/layout`, { headers: cookies.headers() });
        assert.strictEqual(unknown.status, 404, 'unknown dashboardKey must 404');

        // Authenticated GET returns the expected schema.
        const got = await fetch(`${base}/admin/api/dashboard/main/layout`, { headers: cookies.headers() });
        assert.strictEqual(got.status, 200);
        const gotBody = await got.json();
        assert.strictEqual(gotBody.ok, true);
        assert(Array.isArray(gotBody.widgets), 'layout response must include a widgets array');
        assert(gotBody.widgets.some(w => w.widget_key === 'apiSmokeWidget'), 'registered widget must appear in the layout response');

        // PUT without a CSRF token must be rejected.
        const putNoCsrf = await fetch(`${base}/admin/api/dashboard/main/layout`, {
            method: 'PUT', headers: { 'content-type': 'application/json', ...cookies.headers() },
            body: JSON.stringify({ widgets: [{ widgetKey: 'apiSmokeWidget', position: 0, span: 8, visible: true }] })
        });
        assert.strictEqual(putNoCsrf.status, 403, 'PUT without CSRF token must be rejected');

        // PUT with the header-based CSRF token (the fetch-friendly path) succeeds.
        const putOk = await fetch(`${base}/admin/api/dashboard/main/layout`, {
            method: 'PUT', headers: { 'content-type': 'application/json', 'x-csrf-token': csrfToken, ...cookies.headers() },
            body: JSON.stringify({ widgets: [{ widgetKey: 'apiSmokeWidget', position: 0, span: 8, visible: true }] })
        });
        assert.strictEqual(putOk.status, 200);
        const putBody = await putOk.json();
        assert.strictEqual(putBody.widgets[0].span, 8, 'saved span must be reflected in the response');

        // Reset requires CSRF too, then falls back to defaults.
        const reset = await fetch(`${base}/admin/api/dashboard/main/layout/reset`, {
            method: 'POST', headers: { 'x-csrf-token': csrfToken, ...cookies.headers() }
        });
        assert.strictEqual(reset.status, 200);
        const resetBody = await reset.json();
        assert.strictEqual(resetBody.widgets[0].span, 6, 'reset must restore the registry default span');

        // No response so far should ever contain a secret-shaped field.
        for (const body of [gotBody, putBody, resetBody]) {
            const serialized = JSON.stringify(body).toLowerCase();
            for (const banned of ['api_key', 'apikey', 'session_id', 'password', 'secret']) {
                assert(!serialized.includes(banned), `layout API response must never include a ${banned}-shaped field`);
            }
        }

        console.log('admin dashboard layout API smoke: ok');
    } finally {
        await new Promise(resolve => server.close(resolve));
    }
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
