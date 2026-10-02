'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const registry = require('../src/jellyfin/registry');
const lifecycle = require('../src/automation/customer-inactivity-scoped');
const lifecyclePolicy = require('../src/entitlements/jellyfin-lifecycle-policy');
const inactivityRestore = require('../src/entitlements/jellyfin-inactivity-restore');
const serviceAdminControl = require('../src/entitlements/service-admin-control');
const subscriptionState = require('../src/entitlements/subscription-state');
const provisioning = require('../src/jellyfin/resilient-provisioning');

const originalRequest = registry.request;

(async () => {
    const suffix = crypto.randomBytes(5).toString('hex');
    const remoteUserId = `free-user-${suffix}`;
    let customerId = null, userId = null, planId = null, serverId = null, accountId = null;
    let deleteCalls = 0;
    let deleteShouldFail = false;
    let livePlayback = false;
    const staleActivity = new Date(Date.now() - 10 * 86400000).toISOString();

    registry.request = async (_serverId, endpoint, options = {}) => {
        if (endpoint === '/Users') return [{ Id: remoteUserId, Name: `Free_${suffix}`, LastActivityDate: staleActivity }];
        if (endpoint === '/Sessions') return livePlayback ? [{ Id:`session-${suffix}`, UserId:remoteUserId, NowPlayingItem:{ Id:'item-1' } }] : [];
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
        // This scenario is specifically testing failed-removal retry, so make the
        // CURRENT allocation old enough to breach the policy. Historical
        // last_activity_at alone must no longer make a newly allocated user stale.
        const account = await query(`
            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,last_activity_at,is_primary,created_at,access_lane_changed_at)
            VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',$5,TRUE,NOW()-INTERVAL '30 days',NOW()-INTERVAL '30 days') RETURNING id
        `, [customerId, serverId, remoteUserId, `Free_${suffix}`, staleActivity]);
        accountId = account.rows[0].id;

        // Placement authority must never be a retention exemption.
        await serviceAdminControl.pinServer(customerId, serverId, {
            reason: 'integration test: Free account pinned to its current server'
        });

        await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [lifecyclePolicy.KEY, JSON.stringify({ enabled:true, dryRun:false })]);
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

        // If playback starts after DB eligibility but before the destructive
        // action, the live-session guard must skip removal without creating a
        // new inactivity hold.
        livePlayback = true;
        const liveSkip = await lifecycle.runPlanRules();
        assert.strictEqual(liveSkip.enforced, 0, 'active playback at the destructive boundary must not be removed');
        assert.strictEqual(liveSkip.failed, 0, 'active playback is a safety skip, not a deletion failure');
        assert.strictEqual(liveSkip.safetySkipped, 1, 'the live-session race must be counted as a safety skip');
        assert.strictEqual(deleteCalls, 0, 'live playback must block the remote DELETE');
        assert.strictEqual((await query(`SELECT COUNT(*)::int n FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND released_at IS NULL`, [customerId])).rows[0].n, 0,
            'live playback detected before the hold must leave entitlement state unchanged');
        livePlayback = false;

        // A failed remote deletion keeps one durable inactivity hold. The exact
        // account remains present and the next inactivity run retries it.
        deleteShouldFail = true;
        const failedRemoval = await lifecycle.runPlanRules();
        assert.strictEqual(failedRemoval.enforced, 0, 'failed remote removal must not count as enforced');
        assert.strictEqual(failedRemoval.failed, 1, 'failed remote removal must be surfaced for retry');
        assert.strictEqual(deleteCalls, 1, 'failed removal must reach Jellyfin once');
        const stillPresent = await query('SELECT disabled FROM jellyfin_accounts WHERE id=$1', [accountId]);
        assert.strictEqual(stillPresent.rowCount, 1, 'local mapping must survive failed remote deletion');
        assert.strictEqual(stillPresent.rows[0].disabled, false, 'failed deletion must leave the existing account enabled');
        const pendingHold = await query(`SELECT released_at FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND source_key=('plan:'||$2::text) ORDER BY created_at DESC LIMIT 1`, [customerId, planId]);
        assert.strictEqual(pendingHold.rowCount, 1, 'failed enforcement must leave exactly one inactivity hold for retry');
        assert.strictEqual(pendingHold.rows[0].released_at, null, 'failed deletion must keep the inactivity hold active until the retry can finish deletion and end the Free plan');

        // Once the activity policy is breached there is no separate disabled
        // grace state. The successful retry removes the Jellyfin identity now.
        deleteShouldFail = false;
        const removed = await lifecycle.runPlanRules();
        assert.strictEqual(removed.enforced, 1, 'stale Free account should be removed directly');
        assert.strictEqual(removed.failed, 0, 'successful direct removal must complete without errors');
        assert.strictEqual(deleteCalls, 2, 'retry must issue the second Jellyfin DELETE even while the Free account is server-pinned');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE id=$1', [accountId])).rows[0].n, 0, 'Free Jellyfin mapping must be absent after successful remote deletion');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM customers WHERE id=$1', [customerId])).rows[0].n, 1, 'portal customer must survive Jellyfin deletion');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM subscriptions WHERE customer_id=$1', [customerId])).rows[0].n, 1, 'Free subscription history must survive Jellyfin deletion for audit/history');
        const endedSubscription = await query('SELECT status,current_period_end FROM subscriptions WHERE customer_id=$1 AND plan_id=$2 ORDER BY created_at DESC LIMIT 1', [customerId, planId]);
        assert.strictEqual(endedSubscription.rows[0].status, 'cancelled', 'successful inactivity removal must end the Free plan itself');
        assert(new Date(endedSubscription.rows[0].current_period_end).getTime() <= Date.now() + 5000, 'ended Free plan must not retain a future access period');
        const recovery = await query(`SELECT removal_reason FROM customer_media_access_recovery WHERE customer_id=$1 AND service_type='jellyfin' AND access_lane='free'`, [customerId]);
        assert.strictEqual(recovery.rowCount, 1, 'direct inactivity deletion must preserve Free media recovery state');
        assert.match(String(recovery.rows[0].removal_reason || ''), /^Free Server inactivity:/, 'recovery state must retain the actual inactivity removal reason');
        const releasedHold = await query(`SELECT released_at FROM customer_access_holds WHERE customer_id=$1 AND hold_type='inactivity_policy' AND source_key=('plan:'||$2::text) ORDER BY created_at DESC LIMIT 1`, [customerId, planId]);
        assert.strictEqual(releasedHold.rowCount, 1, 'successful inactivity removal keeps hold history for audit');
        assert(releasedHold.rows[0].released_at, 'successful inactivity removal must release the temporary hold after ending the Free plan');

        const noFreeEntitlement = await subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true });
        assert.strictEqual(noFreeEntitlement, null, 'inactivity-removed customer must have no live Free entitlement at all');

        const restoreState = await inactivityRestore.restoreStatus(customerId);
        assert.strictEqual(restoreState.eligible, false, 'terminal inactivity removal must not be restorable');
        assert.strictEqual(restoreState.reason, 'no_live_free_jellyfin_entitlement', 'restore inspection must see no remaining Free plan');

        await provisioning.reconcileCustomer(customerId);
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE customer_id=$1 AND access_lane=\'free\'', [customerId])).rows[0].n, 0,
            'canonical reconciliation must not recreate Free access after the Free plan has ended');

        // Compatibility regression: before inactivity became terminal, an
        // attempted restore could leave the exact Free subscription live with
        // no Free account and a restoreReconcileFailed hold that did not retain
        // the deleted accountId. The detached finalizer must now close that
        // legacy episode instead of warning forever or attempting reprovisioning.
        const legacySubscription = await query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3000 days')
            RETURNING id
        `, [customerId, planId]);
        const legacySubscriptionId = legacySubscription.rows[0].id;
        const legacyHold = await query(`
            INSERT INTO customer_access_holds(customer_id,hold_type,source_key,reason,metadata)
            VALUES(
                $1,
                'inactivity_policy',
                'plan:'||$2::text,
                'Free Server inactivity restore pending successful reprovisioning',
                $3::jsonb
            )
            RETURNING id
        `, [
            customerId,
            planId,
            JSON.stringify({
                subscriptionId: legacySubscriptionId,
                restoreReconcileFailed: true,
                error: 'No eligible Jellyfin server is currently available for plan free-access'
            })
        ]);
        const legacyHoldId = legacyHold.rows[0].id;

        const finalizedLegacy = await lifecycle.finalizeDetachedRemovals();
        assert.strictEqual(finalizedLegacy.failed, 0, 'legacy failed-restores must finalize without error');
        assert.strictEqual(finalizedLegacy.finalized, 1, 'legacy failed-restore must close the stranded Free plan');
        const legacyEnded = await query('SELECT status,current_period_end,service_extension_days FROM subscriptions WHERE id=$1', [legacySubscriptionId]);
        assert.strictEqual(legacyEnded.rows[0].status, 'cancelled', 'legacy stranded Free subscription must be cancelled');
        assert(new Date(legacyEnded.rows[0].current_period_end).getTime() <= Date.now() + 5000, 'legacy stranded Free subscription must end immediately');
        assert.strictEqual(Number(legacyEnded.rows[0].service_extension_days || 0), 0, 'legacy stranded Free subscription must retain no extension access');
        const legacyReleased = await query('SELECT released_at FROM customer_access_holds WHERE id=$1', [legacyHoldId]);
        assert(legacyReleased.rows[0].released_at, 'legacy restore-failure hold must be released after terminal plan closure');
        assert.strictEqual(await subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true }), null,
            'legacy failed restore must converge to no live Free entitlement');
        assert.strictEqual((await query('SELECT COUNT(*)::int n FROM jellyfin_accounts WHERE customer_id=$1 AND access_lane=\'free\'', [customerId])).rows[0].n, 0,
            'legacy failed restore finalization must not recreate a Free account');

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