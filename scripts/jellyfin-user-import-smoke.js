'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');

const remoteByServer = new Map();
const requestCalls = [];
registry.request = async (serverId, endpoint, options = {}) => {
    requestCalls.push({ serverId: String(serverId), endpoint, method: options.method || 'GET' });
    assert.strictEqual(endpoint, '/Users', 'import discovery must remain read-only unless policy application is explicitly requested');
    return remoteByServer.get(String(serverId)) || [];
};

const importer = require('../src/jellyfin/user-import');

async function addServer({ name, slug, serverClass }) {
    const result = await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority,max_users,
            health_status,allow_new_users,trial_enabled,paid_enabled
        ) VALUES($1,$2,$3,$4,$4,'not-used',TRUE,100,100,'healthy',TRUE,TRUE,TRUE)
        RETURNING id
    `, [name, slug, serverClass, `https://${slug}.example.test`]);
    return result.rows[0].id;
}

async function addPlan({ code, name, serverClass, billing = 'month', duration = 30 }) {
    const result = await query(`
        INSERT INTO plans(
            code,name,description,audience,billing_interval,duration_days,price_minor,currency,streams,
            allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,
            allow_live_tv_management,server_class,active,visible,sort_order
        ) VALUES($1,$2,'','direct',$4,$5,0,'USD',1,FALSE,FALSE,TRUE,TRUE,FALSE,$3,TRUE,TRUE,10)
        RETURNING *
    `, [code, name, serverClass, billing, duration]);
    return result.rows[0];
}

async function addBareCustomer(name) {
    const result = await query(`INSERT INTO customers(display_name,note) VALUES($1,'test') RETURNING id`, [name]);
    return result.rows[0].id;
}

function jellyUser(id, name, { admin = false, disabled = false, hidden = false } = {}) {
    return {
        Id: id,
        Name: name,
        HasPassword: true,
        LastLoginDate: '2026-08-14T18:00:00Z',
        LastActivityDate: '2026-08-14T19:00:00Z',
        Policy: { IsAdministrator: admin, IsDisabled: disabled, IsHidden: hidden }
    };
}

(async () => {
    const premiumServer = await addServer({ name: 'Premium A', slug: 'premium-a', serverClass: 'premium' });
    const freeServer = await addServer({ name: 'Free A', slug: 'free-a', serverClass: 'free' });
    const premiumPlan = await addPlan({ code: 'premium-test', name: 'Premium Test', serverClass: 'premium' });
    const freePlan = await addPlan({ code: 'free-test', name: 'Free Test', serverClass: 'free', billing: 'trial', duration: 1 });

    const driftCustomer = await addBareCustomer('Bob Existing');
    await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary)
        VALUES($1,$2,'old-bob-id','Bob',FALSE,TRUE)
    `, [driftCustomer, premiumServer]);

    const linkCustomer = await addBareCustomer('Charlie Existing');

    remoteByServer.set(String(premiumServer), [
        jellyUser('alice-id', 'Alice'),
        jellyUser('new-bob-id', 'Bob'),
        jellyUser('charlie-id', 'Charlie'),
        jellyUser('admin-id', 'ServerAdmin', { admin: true }),
        jellyUser('sleep-id', 'SleepingUser', { disabled: true })
    ]);
    remoteByServer.set(String(freeServer), [jellyUser('free-id', 'FreeUser')]);

    const discovery = await importer.discover();
    assert.strictEqual(discovery.failures.length, 0);
    const byName = new Map(discovery.rows.map(row => [row.jellyfin_username, row]));
    assert.strictEqual(byName.get('Alice').import_status, 'unmanaged');
    assert.strictEqual(byName.get('Bob').import_status, 'identity_drift');
    assert.strictEqual(byName.get('ServerAdmin').import_status, 'administrator');
    assert.strictEqual(byName.get('FreeUser').import_status, 'unmanaged');
    assert.strictEqual(byName.get('SleepingUser').disabled, true, 'discovery may report a legacy remote disabled identity without adopting it as managed state');

    const alice = await importer.createImportedCustomer({
        serverId: premiumServer,
        jellyfinUserId: 'alice-id',
        planId: premiumPlan.id,
        applyPolicy: false
    });
    assert(alice.customer.id);
    assert.strictEqual(alice.account.jellyfin_user_id, 'alice-id');
    assert.strictEqual(alice.account.jellyfin_username, 'Alice');
    assert.strictEqual(alice.account.is_primary, true);
    assert.strictEqual(alice.account.disabled, false);
    assert(alice.subscription, 'plan import must create a migration subscription');
    assert.strictEqual(alice.subscription.source, 'migration');
    assert.strictEqual(alice.subscription.status, 'active');

    const alicePortal = await query('SELECT user_id FROM customers WHERE id=$1', [alice.customer.id]);
    assert.strictEqual(alicePortal.rows[0].user_id, null, 'import must not invent portal credentials or reset the Jellyfin password');

    const audit = await query(`SELECT action,metadata FROM audit_log WHERE entity_id=$1 ORDER BY id DESC LIMIT 1`, [alice.customer.id]);
    assert.strictEqual(audit.rows[0].action, 'jellyfin.import.customer');
    assert.strictEqual(audit.rows[0].metadata.jellyfinUserId, 'alice-id');

    await assert.rejects(
        () => importer.createImportedCustomer({ serverId: premiumServer, jellyfinUserId: 'alice-id', planId: premiumPlan.id }),
        /already managed/i,
        'repeat import must be idempotently rejected rather than duplicate the customer'
    );
    await assert.rejects(
        () => importer.createImportedCustomer({ serverId: premiumServer, jellyfinUserId: 'admin-id', planId: premiumPlan.id }),
        /administrator/i,
        'server administrators must be protected from customer import'
    );
    await assert.rejects(
        () => importer.createImportedCustomer({ serverId: premiumServer, jellyfinUserId: 'charlie-id', planId: freePlan.id }),
        /requires free servers/i,
        'plan/server class mismatch must fail before import'
    );
    await assert.rejects(
        () => importer.createImportedCustomer({ serverId: premiumServer, jellyfinUserId: 'sleep-id', planId: null, applyPolicy: false }),
        /disabled jellyfin users cannot be managed/i,
        'a remote disabled identity must never be adopted as a CAPTAiNFiN managed account'
    );

    const linked = await importer.linkExistingCustomer({
        customerId: linkCustomer,
        serverId: premiumServer,
        jellyfinUserId: 'charlie-id',
        makePrimary: true,
        applyPolicy: false
    });
    assert.strictEqual(linked.account.customer_id, linkCustomer);
    assert.strictEqual(linked.account.jellyfin_user_id, 'charlie-id');
    assert.strictEqual(linked.account.disabled, false);
    const customerCount = await query(`SELECT COUNT(*)::int AS n FROM customers WHERE display_name='Charlie Existing'`);
    assert.strictEqual(customerCount.rows[0].n, 1, 'linking must attach to the existing customer rather than create another customer');

    const rebound = await importer.rebindIdentity({ serverId: premiumServer, jellyfinUserId: 'new-bob-id' });
    assert.strictEqual(rebound.jellyfin_user_id, 'new-bob-id');
    assert.strictEqual(rebound.disabled, false);
    const bob = await query('SELECT jellyfin_user_id,customer_id,disabled FROM jellyfin_accounts WHERE server_id=$1 AND jellyfin_username=$2', [premiumServer, 'Bob']);
    assert.strictEqual(bob.rows[0].jellyfin_user_id, 'new-bob-id');
    assert.strictEqual(bob.rows[0].customer_id, driftCustomer, 'ID rebind must preserve customer ownership');
    assert.strictEqual(bob.rows[0].disabled, false);

    const bulk = await importer.bulkImport({
        selected: [`${freeServer}:free-id`],
        planId: freePlan.id,
        applyPolicy: false
    });
    assert.deepStrictEqual({ total: bulk.total, imported: bulk.imported, failed: bulk.failed }, { total: 1, imported: 1, failed: 0 });
    const freeSubscription = await query(`
        SELECT s.status,s.source,p.code,ja.disabled FROM subscriptions s JOIN plans p ON p.id=s.plan_id
        JOIN jellyfin_accounts ja ON ja.customer_id=s.customer_id
        WHERE ja.server_id=$1 AND ja.jellyfin_user_id='free-id'
    `, [freeServer]);
    assert.strictEqual(freeSubscription.rows[0].status, 'trialing');
    assert.strictEqual(freeSubscription.rows[0].source, 'migration');
    assert.strictEqual(freeSubscription.rows[0].code, 'free-test');
    assert.strictEqual(freeSubscription.rows[0].disabled, false);

    const after = await importer.discover({ serverId: premiumServer });
    const afterMap = new Map(after.rows.map(row => [row.jellyfin_username, row.import_status]));
    assert.strictEqual(afterMap.get('Alice'), 'managed');
    assert.strictEqual(afterMap.get('Bob'), 'managed');
    assert.strictEqual(afterMap.get('Charlie'), 'managed');
    assert.strictEqual(afterMap.get('SleepingUser'), 'unmanaged', 'legacy disabled remote users must remain outside managed account state');

    assert(requestCalls.every(call => call.method === 'GET' && call.endpoint === '/Users'), 'safe import path must not mutate Jellyfin when policy application is disabled');
    console.log('jellyfin user import smoke: ok');
})().finally(async () => {
    await getPool().end();
}).catch(error => {
    console.error(error);
    process.exitCode = 1;
});
