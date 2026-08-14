'use strict';

const assert = require('assert');
const http = require('http');
const { query, getPool } = require('../src/db');
const runtimeSettings = require('../src/platform/runtime-settings');

process.env.SEERR_API_KEY = 'request-sync-test-key';

const remote = {
    users: [
        { id: 41, email: 'existing@example.test', username: 'existing-user' }
    ],
    createCalls: 0,
    passwordCalls: []
};

function readJson(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
            try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
            catch (error) { reject(error); }
        });
        req.on('error', reject);
    });
}

const server = http.createServer(async (req, res) => {
    try {
        if (req.headers['x-api-key'] !== process.env.SEERR_API_KEY) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ message: 'bad api key' }));
        }
        const url = new URL(req.url, 'http://request.test');
        if (req.method === 'GET' && url.pathname === '/api/v1/user') {
            const take = Math.max(1, Number(url.searchParams.get('take') || 10));
            const skip = Math.max(0, Number(url.searchParams.get('skip') || 0));
            const results = remote.users.slice(skip, skip + take);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                pageInfo: {
                    pages: Math.max(1, Math.ceil(remote.users.length / take)),
                    pageSize: take,
                    results: remote.users.length,
                    page: Math.floor(skip / take) + 1
                },
                results
            }));
        }
        if (req.method === 'POST' && url.pathname === '/api/v1/user') {
            const body = await readJson(req);
            if (!body.email || !body.username || !body.password) throw new Error('missing local-user fields');
            if (remote.users.some(user => String(user.email).toLowerCase() === String(body.email).toLowerCase())) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ message: 'User already exists with submitted email.' }));
            }
            const created = { id: 100 + remote.createCalls, email: body.email, username: body.username };
            remote.createCalls += 1;
            remote.users.push(created);
            res.writeHead(201, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(created));
        }
        const password = url.pathname.match(/^\/api\/v1\/user\/(\d+)\/settings\/password$/);
        if (req.method === 'POST' && password) {
            const body = await readJson(req);
            remote.passwordCalls.push({ id: Number(password[1]), newPassword: body.newPassword });
            res.writeHead(204);
            return res.end();
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: `unexpected ${req.method} ${url.pathname}` }));
    } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ message: error.message }));
    }
});

function listen() {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => resolve(server.address()));
    });
}

function closeServer() {
    return new Promise(resolve => server.close(() => resolve()));
}

async function makeServer(name, slug) {
    const result = await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,
            priority,max_users,health_status,allow_new_users,trial_enabled,paid_enabled
        ) VALUES($1,$2,'premium',$3,$3,'not-used',TRUE,100,100,'healthy',TRUE,TRUE,TRUE)
        RETURNING id
    `, [name, slug, `https://${slug}.example.test`]);
    return result.rows[0].id;
}

async function makeCustomer({ username, email = null, serverIds }) {
    const user = await query(`
        INSERT INTO app_users(email,username,password_hash,role,active)
        VALUES($1,$2,'test-hash','customer',TRUE) RETURNING id
    `, [email, username]);
    const customer = await query(`
        INSERT INTO customers(user_id,display_name,email)
        VALUES($1,$2,$3) RETURNING id
    `, [user.rows[0].id, username, email]);
    let primary = true;
    for (const serverId of serverIds) {
        await query(`
            INSERT INTO jellyfin_accounts(
                customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary
            ) VALUES($1,$2,$3,$4,FALSE,$5)
        `, [customer.rows[0].id, serverId, `${username}-${serverId}`, username, primary]);
        primary = false;
    }
    return customer.rows[0].id;
}

(async () => {
    const address = await listen();
    const requestUrl = `http://127.0.0.1:${address.port}`;
    await query(`
        INSERT INTO platform_settings(setting_key,setting_value,updated_at)
        VALUES('platform',$1::jsonb,NOW())
        ON CONFLICT(setting_key) DO UPDATE SET
            setting_value=platform_settings.setting_value || EXCLUDED.setting_value,
            updated_at=NOW()
    `, [JSON.stringify({ overseerrUrl: requestUrl })]);
    await runtimeSettings.reload();

    const firstServer = await makeServer('Premium A', 'premium-a');
    const secondServer = await makeServer('Premium B', 'premium-b');
    const multiServerCustomer = await makeCustomer({
        username: 'multi-user',
        email: 'multi@example.test',
        serverIds: [firstServer, secondServer]
    });
    const noEmailCustomer = await makeCustomer({
        username: 'no-email-user',
        serverIds: [firstServer]
    });
    const existingCustomer = await makeCustomer({
        username: 'existing-user',
        email: 'existing@example.test',
        serverIds: [secondServer]
    });

    const requestSync = require('../src/integrations/request-user-sync');
    const candidates = await requestSync.syncCandidates();
    assert.strictEqual(candidates.length, 3, 'multi-server Jellyfin accounts must collapse to one CAPTaINFiN request user');
    const multi = candidates.find(row => String(row.customer_id) === String(multiServerCustomer));
    assert.strictEqual(multi.active_server_count, 2);
    assert(String(multi.active_servers).includes('Premium A'));
    assert(String(multi.active_servers).includes('Premium B'));

    const first = await requestSync.syncAll();
    assert.deepStrictEqual(first, { total: 3, created: 2, linked: 1, failed: 0 });
    assert.strictEqual(remote.createCalls, 2);
    assert.strictEqual(remote.users.length, 3);

    const linked = await requestSync.requestAccessForCustomer(existingCustomer);
    assert.strictEqual(Number(linked.external_user_id), 41, 'existing request user should be linked by email rather than duplicated');
    assert.strictEqual(linked.password_reset_required, false, 'pre-existing request account password must not be reset');

    const noEmail = await requestSync.requestAccessForCustomer(noEmailCustomer);
    assert(/@captainfin\.invalid$/.test(noEmail.external_email), 'email-optional CAPTaINFiN user needs a deterministic request login');
    assert.strictEqual(noEmail.password_reset_required, true);
    assert.strictEqual(noEmail.external_email, requestSync.fallbackEmail(noEmailCustomer));

    const multiAccess = await requestSync.requestAccessForCustomer(multiServerCustomer);
    assert.strictEqual(multiAccess.password_reset_required, true);

    // Idempotency: a second full sync links all three existing external users,
    // creates none, and must not clear a newly-created user's password prompt.
    const second = await requestSync.syncAll();
    assert.deepStrictEqual(second, { total: 3, created: 0, linked: 3, failed: 0 });
    assert.strictEqual(remote.createCalls, 2);
    const multiAfterSecond = await requestSync.requestAccessForCustomer(multiServerCustomer);
    assert.strictEqual(multiAfterSecond.password_reset_required, true);

    await requestSync.setCustomerPassword(multiServerCustomer, 'Central-Requests-Password-2026!');
    assert.strictEqual(remote.passwordCalls.length, 1);
    assert.strictEqual(remote.passwordCalls[0].id, Number(multiAfterSecond.external_user_id));
    assert.strictEqual(remote.passwordCalls[0].newPassword, 'Central-Requests-Password-2026!');
    const ready = await requestSync.requestAccessForCustomer(multiServerCustomer);
    assert.strictEqual(ready.password_reset_required, false);

    // The provisioning page should group the user's historical identical
    // successful health checks instead of rendering one visual row per tick.
    const { compactRuns } = require('../src/platform/admin-provisioning');
    const grouped = compactRuns([
        { customer_id: multiServerCustomer, customer_name: 'multi-user', action: 'reconcile', status: 'succeeded', detail: {}, started_at: '2026-08-14T20:00:00Z' },
        { customer_id: multiServerCustomer, customer_name: 'multi-user', action: 'reconcile', status: 'succeeded', detail: {}, started_at: '2026-08-14T19:55:00Z' },
        { customer_id: multiServerCustomer, customer_name: 'multi-user', action: 'reconcile', status: 'succeeded', detail: {}, started_at: '2026-08-14T19:50:00Z' }
    ]);
    assert.strictEqual(grouped.length, 1);
    assert.strictEqual(grouped[0].repeat_count, 3);

    console.log('request user sync smoke: ok');
})().finally(async () => {
    await closeServer().catch(() => {});
    await getPool().end();
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
