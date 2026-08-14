'use strict';

const assert = require('assert');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const drift = require('../src/jellyfin/drift-control');

(async () => {
    const server = (await query(`
        INSERT INTO jellyfin_servers(
            name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,
            paid_enabled,trial_enabled,priority,max_users,health_status
        ) VALUES('Drift Premium','drift-premium','premium','https://drift.example.test','test-key',TRUE,TRUE,TRUE,TRUE,10,100,'healthy')
        RETURNING id
    `)).rows[0];
    const plan = (await query(`
        INSERT INTO plans(
            code,name,description,price_minor,currency,billing_interval,duration_days,server_class,streams,
            allow_downloads,allow_video_transcoding,allow_audio_transcoding,allow_remuxing,allow_live_tv,
            allow_live_tv_management,allow_remote_access,active,visible
        ) VALUES(
            'drift-plan','Drift Plan','Policy drift test',1000,'USD','month',30,'premium',3,
            FALSE,FALSE,TRUE,TRUE,FALSE,FALSE,TRUE,TRUE,TRUE
        ) RETURNING id
    `)).rows[0];
    const customer = (await query(`INSERT INTO customers(display_name,email) VALUES('Drift Alice','drift@example.test') RETURNING id`)).rows[0];
    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','admin',NOW(),NOW()+INTERVAL '30 days')
    `, [customer.id, plan.id]);
    const account = (await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary)
        VALUES($1,$2,'remote-alice','DriftAlice',FALSE,TRUE)
        RETURNING *
    `, [customer.id, server.id])).rows[0];

    let remoteUser = null;
    let mode = 'normal';
    const calls = [];
    const originalRequest = registry.request;
    registry.request = async (serverId, path, options = {}) => {
        calls.push({ serverId: String(serverId), path: String(path), method: String(options.method || 'GET').toUpperCase() });
        if (String(path) === '/Library/VirtualFolders') return [{ Name: 'Movies', ItemId: 'lib-movies', CollectionType: 'movies' }];
        if (String(path) === '/Users/remote-alice') {
            if (mode === 'missing') throw new Error('Jellyfin returned HTTP 404 for user');
            if (mode === 'unreachable') throw new Error('ECONNREFUSED simulated');
            return remoteUser;
        }
        throw new Error(`Unexpected Jellyfin request ${path}`);
    };

    try {
        const context = await drift.customerContext(customer.id, new Map());
        const desired = await drift.desiredState(account, context);
        assert.strictEqual(desired.disabled, false);
        assert.strictEqual(desired.policy.EnableContentDownloading, false);
        assert.strictEqual(desired.policy.EnableVideoPlaybackTranscoding, false);
        assert.strictEqual(desired.policy.EnableAudioPlaybackTranscoding, true);
        assert.strictEqual(desired.policy.EnableRemoteAccess, true);
        assert.strictEqual(desired.policy.EnableAllFolders, true);

        remoteUser = { Id: 'remote-alice', Name: 'DriftAlice', Policy: { ...desired.policy } };
        let result = await drift.auditAccount(account.id, { context, catalogCache: new Map() });
        assert.strictEqual(result.status, 'in_sync');
        assert.strictEqual(result.differences.length, 0);

        let state = (await query(`SELECT * FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1`, [account.id])).rows[0];
        assert.strictEqual(state.status, 'in_sync');
        assert(state.last_success_at);
        assert.strictEqual(state.last_error, null);
        assert(new Date(state.next_check_at) > new Date());
        assert(state.desired_hash && state.remote_hash && state.desired_hash === state.remote_hash);

        remoteUser = {
            Id: 'remote-alice',
            Name: 'DriftAliceRenamed',
            Policy: {
                ...desired.policy,
                EnableContentDownloading: true,
                EnableVideoPlaybackTranscoding: true
            }
        };
        result = await drift.auditAccount(account.id, { context, catalogCache: new Map() });
        assert.strictEqual(result.status, 'drift');
        const fields = result.differences.map(item => item.field);
        assert(fields.includes('Username'));
        assert(fields.includes('EnableContentDownloading'));
        assert(fields.includes('EnableVideoPlaybackTranscoding'));
        assert(!fields.includes('AuthenticationProviderId'), 'non-controlled Jellyfin fields must not create drift');

        state = (await query(`SELECT * FROM jellyfin_policy_drift WHERE jellyfin_account_id=$1`, [account.id])).rows[0];
        assert.strictEqual(state.status, 'drift');
        assert(Array.isArray(state.differences) && state.differences.length === 3);
        assert.notStrictEqual(state.desired_hash, state.remote_hash);

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
        assert.strictEqual(state.status, 'unreachable');
        assert(/ECONNREFUSED/.test(state.last_error));
        assert.strictEqual(Number(state.consecutive_failures), 2);
        assert(new Date(state.next_check_at) > new Date());

        // No active subscription means a managed Jellyfin account is desired
        // disabled. This catches an orphaned account that somebody re-enabled
        // directly in Jellyfin after CAPTaINFiN removed entitlement.
        const noPlanCustomer = (await query(`INSERT INTO customers(display_name) VALUES('No Plan Bob') RETURNING id`)).rows[0];
        const noPlanAccount = (await query(`
            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,is_primary)
            VALUES($1,$2,'remote-bob','NoPlanBob',TRUE,TRUE) RETURNING *
        `, [noPlanCustomer.id, server.id])).rows[0];
        const noPlanContext = await drift.customerContext(noPlanCustomer.id, new Map());
        const noPlanDesired = await drift.desiredState(noPlanAccount, noPlanContext);
        assert.strictEqual(noPlanDesired.disabled, true);
        assert.strictEqual(noPlanDesired.policy.IsDisabled, true);

        registry.request = async (serverId, path, options = {}) => {
            calls.push({ serverId: String(serverId), path: String(path), method: String(options.method || 'GET').toUpperCase() });
            if (String(path) === '/Users/remote-bob') {
                return { Id: 'remote-bob', Name: 'NoPlanBob', Policy: { ...noPlanDesired.policy, IsDisabled: false, EnableMediaPlayback: true } };
            }
            if (String(path) === '/Library/VirtualFolders') return [{ Name: 'Movies', ItemId: 'lib-movies' }];
            if (String(path) === '/Users/remote-alice') return { Id: 'remote-alice', Name: 'DriftAlice', Policy: { ...desired.policy } };
            throw new Error(`Unexpected Jellyfin request ${path}`);
        };
        result = await drift.auditAccount(noPlanAccount.id, { context: noPlanContext, catalogCache: new Map() });
        assert.strictEqual(result.status, 'drift');
        assert(result.differences.some(item => item.field === 'IsDisabled'));
        assert(result.differences.some(item => item.field === 'EnableMediaPlayback'));

        // Batch audit discovers rows and audits them read-only. Force all so
        // existing next-check timestamps do not hide coverage.
        const batch = await drift.auditDue({ all: true, limit: 100 });
        assert.strictEqual(batch.total, 2);
        assert(batch.inSync >= 1);
        assert(batch.drift >= 1);

        const stats = await drift.stats();
        assert.strictEqual(Number(stats.total), 2);
        assert(Number(stats.in_sync) >= 1);
        assert(Number(stats.drift) >= 1);
        const rows = await drift.listAuditRows();
        assert.strictEqual(rows.length, 2);
        assert(rows.some(row => String(row.customer_id) === String(noPlanCustomer.id) && row.status === 'drift'));

        assert(calls.length > 0);
        assert(calls.every(call => call.method === 'GET'), 'policy audit must never mutate Jellyfin');
        assert(!calls.some(call => /Playing\/Stop|Policy$/i.test(call.path) && call.method !== 'GET'));

        console.log('jellyfin drift smoke: ok');
    } finally {
        registry.request = originalRequest;
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
