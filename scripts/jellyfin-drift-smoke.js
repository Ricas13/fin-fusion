'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const drift = require('../src/jellyfin/drift-control');

(async () => {
    const suffix = Date.now().toString(36);
    const server = (await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,
            paid_enabled,trial_enabled,priority,max_users,health_status
        ) VALUES($1,$2,'premium','https://drift.example.test','test-key',TRUE,TRUE,TRUE,TRUE,10,100,'healthy')
        RETURNING id
    `, [`Drift Premium ${suffix}`, `drift-premium-${suffix}`])).rows[0];
    const plan = (await query(`
        INSERT INTO plans(
            code,name,description,audience,price_minor,currency,billing_interval,duration_days,server_class,streams,
            allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,
            allow_live_tv_management,allow_remote_access,active,visible
        ) VALUES(
            $1,'Drift Plan','Policy drift current-schema test','direct',1000,'USD','month',30,'premium',3,
            FALSE,FALSE,TRUE,TRUE,FALSE,FALSE,TRUE,TRUE,TRUE
        ) RETURNING id
    `, [`drift-plan-${suffix}`])).rows[0];
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`, [`Drift Alice ${suffix}`, `drift-${suffix}@example.test`])).rows[0];
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','admin_grant',NOW(),NOW()+INTERVAL '30 days')
    `, [customer.id, plan.id]);
    const account = (await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary)
        VALUES($1,$2,$3,$4,FALSE,TRUE)
        RETURNING *
    `, [customer.id, server.id, `remote-alice-${suffix}`, `DriftAlice${suffix}`])).rows[0];

    let remoteUser = null;
    let mode = 'normal';
    const calls = [];
    const originalRequest = registry.request;
    registry.request = async (serverId, requestPath, options = {}) => {
        calls.push({ serverId: String(serverId), path: String(requestPath), method: String(options.method || 'GET').toUpperCase() });
        if (String(requestPath) === '/Library/VirtualFolders') return [{ Name: 'Movies', ItemId: 'lib-movies', CollectionType: 'movies' }];
        if (String(requestPath) === `/Users/${account.jellyfin_user_id}`) {
            if (mode === 'missing') throw new Error('Jellyfin returned HTTP 404 for user');
            if (mode === 'unreachable') throw new Error('ECONNREFUSED simulated');
            return remoteUser;
        }
        throw new Error(`Unexpected Jellyfin request ${requestPath}`);
    };

    let noPlanCustomer = null;
    try {
        const context = await drift.customerContext(customer.id, new Map());
        const desired = await drift.desiredState(account, context);
        assert.strictEqual(desired.disabled, false);
        assert.strictEqual(desired.shouldExist, true);
        assert.strictEqual(desired.policy.IsDisabled, false);
        assert.strictEqual(desired.policy.EnableContentDownloading, false);
        assert.strictEqual(desired.policy.EnableVideoPlaybackTranscoding, false);
        assert.strictEqual(desired.policy.EnableAudioPlaybackTranscoding, true);
        assert.strictEqual(desired.policy.EnableRemoteAccess, true);
        assert.strictEqual(desired.policy.EnableAllFolders, true);

        remoteUser = { Id: account.jellyfin_user_id, Name: account.jellyfin_username, Policy: { ...desired.policy } };
        let result = await drift.auditAccount(account.id, { context, catalogCache: new Map() });
        assert.strictEqual(result.status, 'in_sync');
        assert.deepStrictEqual(result.differences, []);

        let state = (await query(`SELECT * FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1`, [account.id])).rows[0];
        assert.strictEqual(state.status, 'in_sync');
        assert.strictEqual(state.desired_disabled, false);
        assert(state.last_success_at);
        assert.strictEqual(state.last_error, null);
        assert(new Date(state.next_check_at) > new Date());
        assert(state.desired_hash && state.remote_hash && state.desired_hash === state.remote_hash);

        remoteUser = {
            Id: account.jellyfin_user_id,
            Name: `${account.jellyfin_username}-renamed`,
            Policy: { ...desired.policy, IsDisabled: true, EnableContentDownloading: true, EnableVideoPlaybackTranscoding: true }
        };
        result = await drift.auditAccount(account.id, { context, catalogCache: new Map() });
        assert.strictEqual(result.status, 'drift');
        const fields = result.differences.map(item => item.field);
        assert(fields.includes('Username'));
        assert(fields.includes('IsDisabled'), 'out-of-band remote disable must be detected as drift against enabled desired state');
        assert(fields.includes('EnableContentDownloading'));
        assert(fields.includes('EnableVideoPlaybackTranscoding'));
        assert.strictEqual(fields.length, 4, `unexpected policy fields: ${fields.join(', ')}`);

        state = (await query(`SELECT * FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1`, [account.id])).rows[0];
        assert.strictEqual(state.status, 'drift');
        assert.strictEqual(state.desired_disabled, false, 'drift control must never persist disabled as desired state');
        assert.notStrictEqual(state.desired_hash, state.remote_hash);
        const columns = (await query(`SELECT column_name FROM information_schema.columns WHERE table_name='jellyfin_policy_drift'`)).rows.map(row => row.column_name);
        assert(!columns.some(name => /api.*key|credential|password|token/i.test(name)), 'drift state must not persist provider credentials');

        mode = 'missing';
        result = await drift.auditAccount(account.id, { context, catalogCache: new Map() });
        assert.strictEqual(result.status, 'missing');
        state = (await query(`SELECT * FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1`, [account.id])).rows[0];
        assert.strictEqual(state.status, 'missing');
        assert(/404/.test(state.last_error));
        assert.strictEqual(Number(state.consecutive_failures), 1);

        mode = 'unreachable';
        result = await drift.auditAccount(account.id, { context, catalogCache: new Map() });
        assert.strictEqual(result.status, 'unreachable');
        state = (await query(`SELECT * FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1`, [account.id])).rows[0];
        assert.strictEqual(Number(state.consecutive_failures), 2);
        assert(new Date(state.next_check_at) > new Date());

        // A stale managed mapping with no valid entitlement is not a disabled
        // account target. It is an account-presence drift: reconciliation must
        // remove the identity entirely.
        noPlanCustomer = (await query(`INSERT INTO customers(display_name) VALUES($1) RETURNING id`, [`No Plan Bob ${suffix}`])).rows[0];
        const noPlanAccount = (await query(`
            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary)
            VALUES($1,$2,$3,$4,FALSE,TRUE) RETURNING *
        `, [noPlanCustomer.id, server.id, `remote-bob-${suffix}`, `NoPlanBob${suffix}`])).rows[0];
        const noPlanContext = await drift.customerContext(noPlanCustomer.id, new Map());
        const noPlanDesired = await drift.desiredState(noPlanAccount, noPlanContext);
        assert.strictEqual(noPlanDesired.disabled, false);
        assert.strictEqual(noPlanDesired.shouldExist, false);
        assert.strictEqual(noPlanDesired.policy, null);

        registry.request = async (serverId, requestPath, options = {}) => {
            calls.push({ serverId: String(serverId), path: String(requestPath), method: String(options.method || 'GET').toUpperCase() });
            if (String(requestPath) === '/Library/VirtualFolders') return [{ Name: 'Movies', ItemId: 'lib-movies', CollectionType: 'movies' }];
            if (String(requestPath) === `/Users/${account.jellyfin_user_id}`) return { Id: account.jellyfin_user_id, Name: account.jellyfin_username, Policy: { ...desired.policy } };
            if (String(requestPath) === `/Users/${noPlanAccount.jellyfin_user_id}`) return { Id: noPlanAccount.jellyfin_user_id, Name: noPlanAccount.jellyfin_username, Policy: { IsDisabled: false, EnableMediaPlayback: true } };
            throw new Error(`Unexpected Jellyfin request ${requestPath}`);
        };

        result = await drift.auditAccount(noPlanAccount.id, { context: noPlanContext, catalogCache: new Map() });
        assert.strictEqual(result.status, 'drift');
        assert.deepStrictEqual(result.differences, [{ field: 'AccountPresence', expected: 'absent', actual: 'present' }]);
        state = (await query(`SELECT * FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1`, [noPlanAccount.id])).rows[0];
        assert.strictEqual(state.desired_disabled, false);

        await query(`UPDATE jellyfin_policy_drift SET next_check_at=NOW() WHERE jellyfin_account_id IN ($1,$2)`, [account.id, noPlanAccount.id]);
        const batch = await drift.auditDue({ all: false, limit: 100 });
        assert.strictEqual(batch.total, 2);
        assert(batch.inSync >= 1);
        assert(batch.drift >= 1);
        const stats = await drift.stats();
        assert(Number(stats.total) >= 2);
        assert(Number(stats.in_sync) >= 1);
        assert(Number(stats.drift) >= 1);

        assert(calls.length > 0);
        assert(calls.every(call => call.method === 'GET'), 'policy audit must never mutate Jellyfin');
        console.log('jellyfin drift current-schema smoke: ok');
    } finally {
        registry.request = originalRequest;
        if (noPlanCustomer) await query('DELETE FROM customers WHERE id=$1', [noPlanCustomer.id]).catch(() => {});
        await query('DELETE FROM customers WHERE id=$1', [customer.id]).catch(() => {});
        await query('DELETE FROM plans WHERE id=$1', [plan.id]).catch(() => {});
        await query('DELETE FROM jellyfin_servers WHERE id=$1', [server.id]).catch(() => {});
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
