'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const lifecycle = require('../src/automation/customer-inactivity-scoped');
const lifecyclePolicy = require('../src/entitlements/jellyfin-lifecycle-policy');
const inactivityRestore = require('../src/entitlements/jellyfin-inactivity-restore');

const originalRequest = registry.request;

(async () => {
    const suffix = crypto.randomBytes(5).toString('hex');
    const remoteUserId = `free-user-${suffix}`;
    let customerId = null, userId = null, planId = null, serverId = null, accountId = null;
    let deleteCalls = 0;
    let deleteShouldFail = false;
    const staleActivity = new Date(Date.now() - 10 * 86400000).toISOString();

    registry.request = async (_serverId, endpoint, options = {}) => {
        if (endpoint === '/Users') return [{ Id: remoteUserId, Name: `Free_${suffix}`, LastActivityDate: staleActivity }];
        if (endpoint.endsWith('/Policy') && String(options.method || 'GET').toUpperCase() === 'POST') return {};
        if (endpoint === `/Users/${encodeURIComponent(remoteUserId)}` && String(options.method || '').toUpperCase() === 'DELETE') {
            deleteCalls += 1;
            if (deleteShouldFail) throw new Error('Jellyfin Free Server DELETE /Users test failure');
            return {};
        }
        throw new Error(`Unexpected Jellyfin test request: ${options.method || 'GET'} ${endpoint}`);
    };

    try {
        const user = await query(`INSERT INTO app_users(username,password_hash,role,active,email_verified_at) VALUES($1,'test-hash','customer',TRUE,NOW()) RETURNING id`, [`free_lifecycle_${suffix}`]);
        userId = user.rows[0].id;
        const customer = await query(`INSERT INTO customers(user_id,display_name,automation_protected) VALUES($1,$2,FALSE) RETURNING id`, [userId, `Free lifecycle ${suffix}`]);
        customerId = customer.rows[0].id;

        // Clean-install migrations intentionally seed exactly one canonical Free
        // tier plan and enforce that invariant with plans_single_free_tier_idx.
        // Reuse that product instead of fabricating a second Free tier in this
        // lifecycle integration fixture.
        const freePlan = await query(`
            SELECT id,code,billing_interval
            FROM plans
            WHERE is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE
            ORDER BY created_at,id
            LIMIT 1
        `);
        assert.strictEqual(freePlan.rowCount, 1, 'clean install must contain one canonical Free tier plan');
        assert.notStrictEqual(String(freePlan.rows[0].billing_interval || '').toLowerCase(), 'trial', 'canonical Free tier must not be a trial');
        planId = freePlan.rows[0].id;
        await query(`
            UPDATE plans
            SET active=TRUE,visible=TRUE,price_minor=0,server_class='free',service_type='jellyfin',inactivity_policy='{}'::jsonb,updated_at=NOW()
            WHERE id=$1
        `, [planId]);

        const server = await query(`
            INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status,last_health_check)
            VALUES($1,$2,'free','https://free-lifecycle.example.test','key',TRUE,TRUE,TRUE,10,100,'healthy',NOW()) RETURNING id
        `, [`Free lifecycle ${suffix}`, `free-lifecycle-${suffix}`]);
        serverId = server.rows[0].id;
        await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3000 days')`, [customerId, planId]);
        const account = await query(`
            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,last_activity_at,is_primary)
            VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',$5,TRUE) RETURNING id
        `, [customerId, serverId, remoteUserId, `Free_${suffix}`, staleActivity]);
        accountId = account.rows[0].id;

        await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [lifecyclePolicy.KEY, JSON.stringify({ enabled:true, dryRun:false, freeNoPlaybackDays:7 })]);
        await query(`SELECT public.record_activity_worker_heartbeat($1,$2,$3,FALSE,$4::jsonb)`, [`free-lifecycle-test-${suffix}`, 'test', 'test', '{}']);
        await query(`
            INSERT INTO jellyfin_activity_poll_state(server_id,last_attempt_at,last_success_at,last_failure_at,last_error,updated_at)
            VALUES($1,NOW(),NOW(),NULL,NULL,NOW())
            ON CONFLICT(server_id) DO UPDATE SET
                last_attempt_at=EXCLUDED.last_attempt_at,
                last_success_at=EXCLUDED.last_success_at,
                last_failure_at=NULL,
                last_error=NULL,
                updated_at=NOW()
        `, [serverId]);

        // A failed remote deletion must not strand the customer behind an
        // inactivity hold. They remain present + enabled until deletion can be
        // retried successfully.
        deleteShouldFail = true;
        const failedRemoval = await lifecycle.runPlanRules();
        assert.strictEqual(failedRemoval.enforced, 0, 'failed remote removal must not count as enforced');
        assert.strictEqual(failedRemoval.failed, 1, 'failed remote removal must be surfaced for retry');
        assert.strictEqual(deleteCalls, 1, 'failed removal must reach Jellyfin once');
        const stillPresent = await query('SELECT disabled FROM jellyfin_accounts WHERE id=$1', [accountId]);
        assert.strictEqual(stillPresent.rowCount, 1, 'local mapping must survive failed remote deletion');
        assert.strictEqual(stillPresent.rows[0].disabled, false, 'failed deletion must leave the existing account enabled');
        const rolledBackHold = await query(`SELECT released_at FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND source_key=('plan:'||$2::text) ORDER BY created_at DESC LIMIT 1`, [customerId, planId]);
        assert.strictEqual(rolledBackHold.rowCount, 1, 'failed enforcement should have created an inactivity hold before reconciliation');
        assert(rolledBackHold.rows[0].released_at, 'failed deletion must roll the inactivity hold back');

        // Once the activity policy is breached there is no separate disabled
        // grace state. The successful retry removes the Jellyfin identity now.
        deleteShouldFail = false;
        const removed = await lifecycle.runPlanRules();
        assert.strictEqual(removed.enforced, 1, 'stale Free account should be removed directly');
        assert.strictEqual(removed.failed, 0, 'successful direct removal must complete without errors');
        assert.strictEqual(deleteCalls, 2, 'retry must issue the second Jellyfin DELETE');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE id=$1', [accountId])).rows[0].n, 0, 'Free Jellyfin mapping must be absent after successful remote deletion');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM customers WHERE id=$1', [customerId])).rows[0].n, 1, 'portal customer must survive Jellyfin deletion');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [customerId])).rows[0].n, 1, 'Free subscription history must survive Jellyfin deletion');
        const activeHold = await query(`SELECT released_at FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND source_key=('plan:'||$2::text) ORDER BY created_at DESC LIMIT 1`, [customerId, planId]);
        assert.strictEqual(activeHold.rowCount, 1, 'successful inactivity removal must leave the Free-lane hold active');
        assert.strictEqual(activeHold.rows[0].released_at, null, 'inactivity hold must remain active until explicit restoration');

        const pending = await lifecycle.processPendingDeletions(await lifecyclePolicy.get());
        assert.deepStrictEqual(pending, { processed:0, deleted:0, restored:0, failed:0, deferred:0, serverFailures:0 }, 'binary lifecycle must have no post-disable deletion queue');

        // Explicit restoration means absent -> freshly provisioned + enabled,
        // never toggling a disabled account back on.
        let restoredAccountId = null;
        const restored = await inactivityRestore.restoreDisabledFreeAccess(customerId, {
            actorUserId: null,
            reconcile: async id => {
                assert.strictEqual(id, customerId);
                const replacement = await query(`
                    INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,last_activity_at,is_primary)
                    VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',NOW(),TRUE) RETURNING id
                `, [customerId, serverId, `restored-${remoteUserId}`, `Free_restored_${suffix}`]);
                restoredAccountId = replacement.rows[0].id;
                return { active:true, account:replacement.rows[0] };
            }
        });
        assert.strictEqual(restored.enabled, true, 'explicit Free restoration must converge to an enabled account');
        assert(restoredAccountId, 'restoration must create a replacement Jellyfin account');
        const restoredRow = await query('SELECT disabled FROM jellyfin_accounts WHERE id=$1', [restoredAccountId]);
        assert.strictEqual(restoredRow.rowCount, 1);
        assert.strictEqual(restoredRow.rows[0].disabled, false, 'replacement Free account must be enabled');
        const releasedHold = await query(`SELECT released_at FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND source_key=('plan:'||$2::text) ORDER BY created_at DESC LIMIT 1`, [customerId, planId]);
        assert(releasedHold.rows[0].released_at, 'explicit restore must release the inactivity hold');

        console.log('free server lifecycle db smoke: ok');
    } finally {
        registry.request = originalRequest;
        if (customerId) await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        if (serverId) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
        if (userId) await query('DELETE FROM app_users WHERE id=$1', [userId]).catch(() => {});
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
