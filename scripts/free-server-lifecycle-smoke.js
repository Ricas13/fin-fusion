'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const lifecycle = require('../src/automation/customer-inactivity-scoped');
const lifecyclePolicy = require('../src/entitlements/jellyfin-lifecycle-policy');
const inactivityHolds = require('../src/entitlements/inactivity-hold-reconciliation');
const cleanupReturn = require('../src/entitlements/jellyfin-cleanup-return');

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

        await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [lifecyclePolicy.KEY, JSON.stringify({ enabled:true, dryRun:false, freeNoPlaybackDays:7, freeDeleteAfterDisableDays:1, trialDeleteAfterDisableDays:30, paidDeleteAfterDisableDays:30 })]);
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

        const disable = await lifecycle.runPlanRules();
        assert.strictEqual(disable.enforced, 1, 'stale inherited Free plan should be disabled');
        assert.strictEqual(disable.failed, 0, 'disable stage must complete without errors');
        const disabled = await query('SELECT disabled FROM jellyfin_accounts WHERE id=$1', [accountId]);
        assert.strictEqual(disabled.rows[0].disabled, true, 'Free Jellyfin account must be disabled remotely and locally');
        const hold = await query(`SELECT released_at FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND source_key=('plan:'||$2::text) ORDER BY created_at DESC LIMIT 1`, [customerId, planId]);
        assert.strictEqual(hold.rowCount, 1, 'disable must create a Free-lane inactivity hold');
        assert.strictEqual(hold.rows[0].released_at, null, 'inactivity hold must remain active');
        const ledger = await query(`SELECT id,disabled_at,delete_after,deleted_at,restored_at FROM jellyfin_account_lifecycle WHERE account_id=$1`, [accountId]);
        assert.strictEqual(ledger.rowCount, 1, 'disable must schedule durable lifecycle deletion');
        assert.strictEqual(ledger.rows[0].deleted_at, null);
        assert.strictEqual(ledger.rows[0].restored_at, null);
        const scheduledHours = (new Date(ledger.rows[0].delete_after) - new Date(ledger.rows[0].disabled_at)) / 3600000;
        assert(scheduledHours > 23.9 && scheduledHours < 24.1, 'Free deletion timer must honor global one-day grace');

        const released = await inactivityHolds.releaseObsoleteForCustomer(customerId);
        assert.strictEqual(released, 0, 'globally inherited lifecycle policy must not release its active hold');

        await query(`UPDATE jellyfin_account_lifecycle SET disabled_at=NOW()-INTERVAL '2 days',delete_after=NOW()-INTERVAL '1 day' WHERE account_id=$1`, [accountId]);
        const cfg = await lifecyclePolicy.get();
        deleteShouldFail = true;
        const failedDelete = await lifecycle.processPendingDeletions(cfg);
        assert.strictEqual(failedDelete.failed, 1, 'remote delete failure must be reported for scheduler retry');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE id=$1', [accountId])).rows[0].n, 1, 'local mapping must survive failed remote deletion');
        assert.strictEqual((await query('SELECT deleted_at FROM jellyfin_account_lifecycle WHERE account_id=$1', [accountId])).rows[0].deleted_at, null, 'ledger must stay pending after failed remote deletion');

        deleteShouldFail = false;
        const deleted = await lifecycle.processPendingDeletions(cfg);
        assert.strictEqual(deleted.deleted, 1, 'retry must delete the due Free Jellyfin user');
        assert.strictEqual(deleteCalls, 2, 'failed deletion and successful retry must both reach Jellyfin');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE id=$1', [accountId])).rows[0].n, 0, 'local Free mapping must be removed only after remote success');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM customers WHERE id=$1', [customerId])).rows[0].n, 1, 'portal customer must survive Jellyfin deletion');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [customerId])).rows[0].n, 1, 'Free subscription history must survive Jellyfin deletion');
        const deletedLedger = await query('SELECT account_id,deleted_at,restored_at FROM jellyfin_account_lifecycle WHERE customer_id=$1', [customerId]);
        assert.strictEqual(deletedLedger.rows[0].account_id, null, 'deleted lifecycle record must release the account FK');
        assert(deletedLedger.rows[0].deleted_at, 'deleted lifecycle record must be timestamped');

        let reconcileCalls = 0;
        const returned = await cleanupReturn.restoreReturningCustomer(customerId, { reconcile: async id => { assert.strictEqual(id, customerId); reconcileCalls += 1; } });
        assert.strictEqual(returned.freeLifecycleRestored, true, 'returning Free customer must be allowed to rebuild after physical deletion');
        assert.strictEqual(reconcileCalls, 1, 'portal return must trigger one reconcile');
        const releasedHold = await query(`SELECT released_at FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND source_key=('plan:'||$2::text) ORDER BY created_at DESC LIMIT 1`, [customerId, planId]);
        assert(releasedHold.rows[0].released_at, 'portal return must release the deletion-preserving inactivity hold');
        assert((await query('SELECT restored_at FROM jellyfin_account_lifecycle WHERE customer_id=$1', [customerId])).rows[0].restored_at, 'portal return must close the lifecycle record');

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
