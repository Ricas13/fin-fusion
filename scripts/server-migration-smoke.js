'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');

const remote = new Map();
let failSourceDisableFor = null;

function state(serverId) {
    const key = String(serverId);
    if (!remote.has(key)) remote.set(key, { users: new Map(), libraries: [{ Id: `lib-${key}`, ItemId: `lib-${key}`, Name: 'Movies' }] });
    return remote.get(key);
}

registry.request = async (serverId, endpoint, options = {}) => {
    const s = state(serverId);
    if (endpoint === '/Library/VirtualFolders') return s.libraries;
    if (endpoint === '/Users') return Array.from(s.users.values()).map(u => ({ Id: u.id, Name: u.name }));
    if (endpoint === '/Users/New' && options.method === 'POST') {
        const name = String(options.body?.Name || '');
        if (Array.from(s.users.values()).some(u => u.name.toLowerCase() === name.toLowerCase())) throw new Error('duplicate username');
        const id = `remote-${serverId}-${s.users.size + 1}`;
        s.users.set(id, { id, name, disabled: false, password: options.body?.Password || '' });
        return { Id: id, Name: name };
    }
    const userRecord = endpoint.match(/^\/Users\/([^/]+)$/);
    if (userRecord && (!options.method || options.method === 'GET')) {
        const user = s.users.get(userRecord[1]);
        if (!user) throw new Error(`remote user ${userRecord[1]} missing`);
        return { Id: user.id, Name: user.name, Policy: user.policy || {} };
    }
    const policy = endpoint.match(/^\/Users\/([^/]+)\/Policy$/);
    if (policy && options.method === 'POST') {
        const user = s.users.get(policy[1]);
        if (!user) throw new Error(`remote user ${policy[1]} missing`);
        if (failSourceDisableFor === policy[1] && options.body?.IsDisabled === true) throw new Error('simulated source disable failure');
        user.disabled = Boolean(options.body?.IsDisabled);
        user.policy = options.body;
        return {};
    }
    const password = endpoint.match(/^\/Users\/([^/]+)\/Password$/);
    if (password && options.method === 'POST') {
        const user = s.users.get(password[1]);
        if (!user) throw new Error('remote user missing');
        user.password = options.body?.NewPw || '';
        return {};
    }
    const remove = endpoint.match(/^\/Users\/([^/]+)$/);
    if (remove && options.method === 'DELETE') {
        s.users.delete(remove[1]);
        return {};
    }
    throw new Error(`Unexpected registry request ${options.method || 'GET'} ${endpoint}`);
};

const migration = require('../src/jellyfin/server-migration');
const resilient = require('../src/jellyfin/resilient-provisioning');

async function makeServer(name, slug) {
    const result = await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,base_url,public_url,api_key_encrypted,enabled,priority,max_users,
            health_status,allow_new_users,trial_enabled,paid_enabled
        ) VALUES($1,$2,'premium',$3,$3,'not-used-by-stub',TRUE,100,100,'healthy',TRUE,TRUE,TRUE)
        RETURNING *
    `, [name, slug, `https://${slug}.example.test`]);
    state(result.rows[0].id);
    return result.rows[0];
}

async function makePlan(code, serverIds) {
    const result = await query(`
        INSERT INTO plans(
            code,name,audience,billing_interval,duration_days,price_minor,currency,streams,
            allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_live_tv,
            server_class,active,visible,library_access_mode,library_names,placement_strategy
        ) VALUES($1,$2,'direct','month',30,600,'USD',3,TRUE,FALSE,TRUE,TRUE,'premium',TRUE,TRUE,'include',ARRAY['Movies'],'balanced')
        RETURNING *
    `, [code, `Plan ${code}`]);
    for (const serverId of serverIds) {
        await query('INSERT INTO plan_server_eligibility(plan_id,server_id,weight) VALUES($1,$2,100)', [result.rows[0].id, serverId]);
    }
    return result.rows[0];
}

async function makeCustomer(username, planId, sourceServer, remoteId) {
    const user = await query(`
        INSERT INTO app_users(username,password_hash,role,active)
        VALUES($1,'test-hash','customer',TRUE) RETURNING id
    `, [username]);
    const customer = await query(`INSERT INTO customers(user_id,display_name) VALUES($1,$2) RETURNING id`, [user.rows[0].id, username]);
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')
    `, [customer.rows[0].id, planId]);
    const account = await query(`
        INSERT INTO jellyfin_accounts(
            customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary,password_setup_required
        ) VALUES($1,$2,$3,$4,FALSE,TRUE,FALSE) RETURNING *
    `, [customer.rows[0].id, sourceServer.id, remoteId, username]);
    state(sourceServer.id).users.set(remoteId, { id: remoteId, name: username, disabled: false, password: 'unknown-source-password' });
    return { customerId: customer.rows[0].id, account: account.rows[0] };
}

(async () => {
    const source = await makeServer('Source', 'source');
    const target = await makeServer('Target', 'target');
    const outside = await makeServer('Outside Pool', 'outside');
    const plan = await makePlan('migration-plan', [source.id, target.id]);
    const first = await makeCustomer('move-user', plan.id, source, 'source-user-1');

    const candidates = await migration.migrationCandidates();
    assert(candidates.some(c => String(c.customer_id) === String(first.customerId)), 'customer should be offered as migration candidate');

    const check = await migration.preflight(first.customerId, target.id);
    assert.strictEqual(check.source.jellyfin_username, 'move-user');
    assert.strictEqual(check.target.id, target.id);
    assert.strictEqual(check.libraryAccess.missing.length, 0);

    await assert.rejects(() => migration.preflight(first.customerId, outside.id), error => error.code === 'TARGET_NOT_ELIGIBLE');

    const created = await migration.createMigration(first.customerId, target.id, null);
    const completed = await migration.executeMigration(created.id);
    assert.strictEqual(completed.status, 'succeeded');
    assert.strictEqual(completed.source_username, 'move-user');
    assert.strictEqual(completed.target_username, 'move-user');
    assert.strictEqual(completed.target_password_reset_required, true);

    const accountsAfterMove = await query(`
        SELECT id,server_id,disabled,is_primary,password_setup_required,jellyfin_user_id
        FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY is_primary DESC
    `, [first.customerId]);
    assert.strictEqual(accountsAfterMove.rowCount, 2);
    const primary = accountsAfterMove.rows.find(row => row.is_primary);
    const old = accountsAfterMove.rows.find(row => String(row.server_id) === String(source.id));
    assert.strictEqual(String(primary.server_id), String(target.id));
    assert.strictEqual(primary.disabled, false);
    assert.strictEqual(primary.password_setup_required, true);
    assert.strictEqual(old.disabled, true);
    assert.strictEqual(old.is_primary, false);

    // Routine reconciliation must honour the migrated primary account rather
    // than silently re-selecting the older source account by creation order.
    await resilient.reconcileCustomer(first.customerId);
    const afterReconcile = await query(`SELECT server_id,disabled,is_primary FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY is_primary DESC`, [first.customerId]);
    assert.strictEqual(String(afterReconcile.rows[0].server_id), String(target.id));
    assert.strictEqual(afterReconcile.rows[0].disabled, false);
    assert(afterReconcile.rows.some(row => String(row.server_id) === String(source.id) && row.disabled === true));

    // A successful customer-set password clears the post-migration prompt.
    await resilient.setJellyfinPassword(first.customerId, primary.id, 'New-Migration-Password-2026!');
    const passwordFlag = await query('SELECT password_setup_required FROM jellyfin_accounts WHERE id=$1', [primary.id]);
    assert.strictEqual(passwordFlag.rows[0].password_setup_required, false);

    const rolledBack = await migration.rollbackMigration(created.id, null);
    assert.strictEqual(rolledBack.status, 'rolled_back');
    const afterRollback = await query(`SELECT server_id,disabled,is_primary FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY is_primary DESC`, [first.customerId]);
    assert.strictEqual(String(afterRollback.rows[0].server_id), String(source.id));
    assert.strictEqual(afterRollback.rows[0].disabled, false);
    assert(afterRollback.rows.some(row => String(row.server_id) === String(target.id) && row.disabled === true));

    // Exact username preservation is a preflight requirement; CAPTAiNFiN will
    // not silently add a numeric suffix during a controlled move.
    const second = await makeCustomer('taken-name', plan.id, source, 'source-user-2');
    state(target.id).users.set('foreign-taken', { id: 'foreign-taken', name: 'taken-name', disabled: false });
    await assert.rejects(() => migration.preflight(second.customerId, target.id), error => error.code === 'TARGET_USERNAME_EXISTS');

    // Missing required libraries block the move before a target user is created.
    state(target.id).users.delete('foreign-taken');
    const third = await makeCustomer('missing-lib', plan.id, source, 'source-user-3');
    state(target.id).libraries = [];
    await assert.rejects(() => migration.preflight(third.customerId, target.id), error => error.code === 'TARGET_LIBRARIES_MISSING');
    state(target.id).libraries = [{ Id: 'lib-target', ItemId: 'lib-target', Name: 'Movies' }];

    // If source disable fails during cutover, the target is disabled and the
    // source remains/restores as the active primary account.
    const fourth = await makeCustomer('cutover-fail', plan.id, source, 'source-user-4');
    const fourthCreated = await migration.createMigration(fourth.customerId, target.id, null);
    failSourceDisableFor = 'source-user-4';
    await assert.rejects(() => migration.executeMigration(fourthCreated.id), /simulated source disable failure/);
    failSourceDisableFor = null;
    const failedMigration = await migration.migrationForId(fourthCreated.id);
    assert.strictEqual(failedMigration.status, 'failed');
    assert.strictEqual(failedMigration.failure_stage, 'disable_source');
    const fourthAccounts = await query(`SELECT server_id,disabled,is_primary FROM jellyfin_accounts WHERE customer_id=$1 ORDER BY is_primary DESC`, [fourth.customerId]);
    const fourthSource = fourthAccounts.rows.find(row => String(row.server_id) === String(source.id));
    const fourthTarget = fourthAccounts.rows.find(row => String(row.server_id) === String(target.id));
    assert.strictEqual(fourthSource.is_primary, true);
    assert.strictEqual(fourthSource.disabled, false);
    assert.strictEqual(fourthTarget.disabled, true);

    console.log('server migration smoke: ok');
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});