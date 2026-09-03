'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const accessHolds = require('../src/entitlements/access-holds');
const restore = require('../src/entitlements/jellyfin-inactivity-restore');
const grace = require('../src/entitlements/jellyfin-inactivity-grace');

(async () => {
    const suffix = crypto.randomBytes(5).toString('hex');
    const created = { customers: [], users: [], servers: [] };

    async function fixture(label, { unrelatedHold = false } = {}) {
        const user = await query(`INSERT INTO app_users(username,password_hash,role,active,email_verified_at) VALUES($1,'test-hash','customer',TRUE,NOW()) RETURNING id`, [`reenable_${label}_${suffix}`]);
        created.users.push(user.rows[0].id);
        const customer = await query(`INSERT INTO customers(user_id,display_name,automation_protected) VALUES($1,$2,FALSE) RETURNING id`, [user.rows[0].id, `Re-enable ${label} ${suffix}`]);
        const customerId = customer.rows[0].id;
        created.customers.push(customerId);

        const plan = await query(`SELECT id FROM plans WHERE is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE ORDER BY created_at,id LIMIT 1`);
        assert.strictEqual(plan.rowCount, 1, 'clean install must contain the canonical Free tier plan');
        const planId = plan.rows[0].id;

        const server = await query(`
            INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status,last_health_check)
            VALUES($1,$2,'free','https://reenable.example.test','key',TRUE,TRUE,TRUE,10,100,'healthy',NOW()) RETURNING id
        `, [`Re-enable ${label} ${suffix}`, `reenable-${label}-${suffix}`]);
        created.servers.push(server.rows[0].id);
        await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3000 days')`, [customerId, planId]);

        const oldActivity = new Date(Date.now() - 20 * 86400000);
        const account = await query(`
            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,last_activity_at,is_primary)
            VALUES($1,$2,$3,$4,TRUE,'jellyfin','free',$5,TRUE) RETURNING id,last_activity_at
        `, [customerId, server.rows[0].id, `remote-${label}-${suffix}`, `Free_${label}_${suffix}`, oldActivity]);
        const accountId = account.rows[0].id;

        const hold = await accessHolds.addHold({
            customerId,
            type: 'inactivity_policy',
            sourceKey: `plan:${planId}`,
            reason: 'Free-plan Jellyfin usage rule: DB smoke'
        });
        await query(`
            INSERT INTO jellyfin_account_lifecycle(account_id,customer_id,server_id,jellyfin_user_id,jellyfin_username,category,reason,policy_source,disabled_at,delete_after,metadata)
            VALUES($1,$2,$3,$4,$5,'free','DB smoke inactivity','plan',NOW()-INTERVAL '1 hour',NOW()+INTERVAL '1 day','{}'::jsonb)
        `, [accountId, customerId, server.rows[0].id, `remote-${label}-${suffix}`, `Free_${label}_${suffix}`]);
        if (unrelatedHold) {
            await accessHolds.addHold({ customerId, type: 'admin_suspended', sourceKey: 'db-smoke', reason: 'Unrelated admin hold must survive' });
        }
        return { customerId, planId, accountId, oldActivity, holdId: hold.id };
    }

    const candidate = accountId => ({
        account_id: accountId,
        eligible: true,
        reasons: [],
        policy: { minimumObservationHours: 24, noPlaybackDays: 7, minimumPlaybackMinutes: null, playbackWindowDays: 7 }
    });

    try {
        const normal = await fixture('normal');
        const normalResult = await restore.restoreDisabledFreeAccess(normal.customerId, {
            actorUserId: null,
            reconcile: async customerId => {
                const holds = await accessHolds.activeHolds(customerId);
                assert(!holds.some(row => row.hold_type === 'inactivity_policy'), 'reconcile must run only after the matching inactivity hold is released');
                await query(`UPDATE jellyfin_accounts SET disabled=FALSE WHERE customer_id=$1 AND account_purpose='jellyfin' AND access_lane='free'`, [customerId]);
                return { active: true };
            }
        });
        assert.strictEqual(normalResult.enabled, true, 'normal admin restore must finish with Jellyfin enabled');
        assert.strictEqual(normalResult.blocked, false);
        assert.strictEqual((await query(`SELECT released_at FROM customer_access_holds WHERE id=$1`, [normal.holdId])).rows[0].released_at != null, true, 'matching inactivity hold must be released');
        const normalLifecycle = await query(`SELECT restored_at,metadata FROM jellyfin_account_lifecycle WHERE account_id=$1`, [normal.accountId]);
        assert(normalLifecycle.rows[0].restored_at, 'pending Free lifecycle must be closed by explicit admin restore');
        assert.strictEqual(normalLifecycle.rows[0].metadata.restoredReason, 'admin_reenable');
        assert.strictEqual(normalLifecycle.rows[0].metadata.reenableReconcilePending, false, 'successful reconciliation must clear the durable retry marker');
        const activityAfter = (await query(`SELECT last_activity_at FROM jellyfin_accounts WHERE id=$1`, [normal.accountId])).rows[0].last_activity_at;
        assert.strictEqual(new Date(activityAfter).getTime(), normal.oldActivity.getTime(), 'admin restore must not fabricate Jellyfin activity timestamps');

        const graceRows = await grace.applyRestorationGrace([candidate(normal.accountId)]);
        assert.strictEqual(graceRows[0].eligible, false, 'freshly restored account must not be immediately disabled again');
        assert.strictEqual(graceRows[0].restoration_grace, true);
        assert(new Date(graceRows[0].restoration_grace_until).getTime() > Date.now() + 6 * 86400000, 'restore grace must honor the plan observation window');

        const retry = await fixture('retry');
        await assert.rejects(
            restore.restoreDisabledFreeAccess(retry.customerId, {
                actorUserId: null,
                reconcile: async () => { throw new Error('simulated Jellyfin outage'); }
            }),
            /simulated Jellyfin outage/,
            'a remote reconciliation failure must surface to the operator'
        );
        const afterFailure = await query(`SELECT disabled FROM jellyfin_accounts WHERE id=$1`, [retry.accountId]);
        assert.strictEqual(afterFailure.rows[0].disabled, true, 'failed remote reconciliation must leave the actual account disabled');
        assert.strictEqual((await query(`SELECT released_at FROM customer_access_holds WHERE id=$1`, [retry.holdId])).rows[0].released_at != null, true, 'the local inactivity hold transition may already be committed when remote reconciliation fails');
        const failedLifecycle = await query(`SELECT restored_at,metadata FROM jellyfin_account_lifecycle WHERE account_id=$1`, [retry.accountId]);
        assert(failedLifecycle.rows[0].restored_at, 'the local lifecycle transition must remain durable after a remote failure');
        assert.strictEqual(failedLifecycle.rows[0].metadata.reenableReconcilePending, true, 'failed remote reconciliation must leave a durable retry marker');

        const retryResult = await restore.restoreDisabledFreeAccess(retry.customerId, {
            actorUserId: null,
            reconcile: async customerId => {
                await query(`UPDATE jellyfin_accounts SET disabled=FALSE WHERE customer_id=$1 AND account_purpose='jellyfin' AND access_lane='free'`, [customerId]);
                return { active: true };
            }
        });
        assert.strictEqual(retryResult.resumed, true, 'second admin action must resume the already-prepared restore instead of requiring the released hold');
        assert.strictEqual(retryResult.enabled, true, 'retry must be able to finish enabling Jellyfin');
        const retriedLifecycle = await query(`SELECT metadata FROM jellyfin_account_lifecycle WHERE account_id=$1`, [retry.accountId]);
        assert.strictEqual(retriedLifecycle.rows[0].metadata.reenableReconcilePending, false, 'successful retry must clear the durable retry marker');

        const automatic = await fixture('automatic');
        await accessHolds.releaseHold({ customerId: automatic.customerId, type: 'inactivity_policy', sourceKey: `plan:${automatic.planId}` });
        await query(`
            UPDATE jellyfin_account_lifecycle
            SET restored_at=NOW(),metadata=metadata||$2::jsonb,updated_at=NOW()
            WHERE account_id=$1
        `, [automatic.accountId, JSON.stringify({ restoredReason: 'activity_after_disable' })]);
        const automaticRows = await grace.applyRestorationGrace([candidate(automatic.accountId)]);
        assert.strictEqual(automaticRows[0].eligible, true, 'automatic/non-admin lifecycle restoration must not receive the admin observation grace');
        assert.strictEqual(Boolean(automaticRows[0].restoration_grace), false, 'only explicit admin re-enables may reset the inactivity observation window');

        const blocked = await fixture('blocked', { unrelatedHold: true });
        const blockedResult = await restore.restoreDisabledFreeAccess(blocked.customerId, {
            actorUserId: null,
            reconcile: async () => ({ active: false })
        });
        assert.strictEqual(blockedResult.blocked, true, 'unrelated holds must continue to block access');
        assert(blockedResult.remainingHolds.some(row => row.type === 'admin_suspended'), 'unrelated admin hold must be preserved');
        assert(!blockedResult.remainingHolds.some(row => row.type === 'inactivity_policy'), 'only the matching inactivity hold should be released');
        assert.strictEqual((await query(`SELECT disabled FROM jellyfin_accounts WHERE id=$1`, [blocked.accountId])).rows[0].disabled, true, 'blocked customer must not be falsely reported as enabled');

        // Bulk administrator release is deliberately narrower than a global
        // unblock: it must clear every administrator-owned hold type that the
        // admin API can create while leaving unrelated subsystem holds intact.
        const adminBulk = await fixture('admin-bulk');
        for (const [type, sourceKey] of [
            ['admin_disabled', 'db-smoke-disabled'],
            ['admin_suspended', 'db-smoke-suspended'],
            ['admin_hold', 'db-smoke-generic'],
            ['legacy', 'db-smoke-legacy']
        ]) {
            await accessHolds.addHold({
                customerId: adminBulk.customerId,
                type,
                sourceKey,
                reason: `DB smoke ${type}`
            });
        }
        const releasedAdminCount = await accessHolds.releaseAllAdminHolds(adminBulk.customerId);
        assert.strictEqual(releasedAdminCount, 4, 'bulk admin release must clear every administrator-owned hold, including generic admin_hold');
        const remainingAfterAdminRelease = await accessHolds.activeHolds(adminBulk.customerId);
        assert.deepStrictEqual(
            remainingAfterAdminRelease.map(row => row.hold_type),
            ['inactivity_policy'],
            'bulk admin release must preserve unrelated subsystem holds'
        );
        const adminReleaseAudit = await query(`
            SELECT metadata
            FROM audit_log
            WHERE action='customer.access_hold.release_admin'
              AND entity_type='customer'
              AND entity_id=$1
            ORDER BY created_at DESC,id DESC
            LIMIT 1
        `, [adminBulk.customerId]);
        assert.strictEqual(adminReleaseAudit.rowCount, 1, 'bulk admin release must create an audit event');
        assert.strictEqual(Number(adminReleaseAudit.rows[0].metadata.released), 4, 'bulk admin release audit must record the released count');
        assert(adminReleaseAudit.rows[0].metadata.holds.some(row => row.type === 'admin_hold'), 'bulk admin release audit must include the generic admin hold');

        console.log('admin jellyfin re-enable db smoke: ok');
    } finally {
        for (const customerId of created.customers.reverse()) await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        for (const serverId of created.servers.reverse()) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
        for (const userId of created.users.reverse()) await query('DELETE FROM app_users WHERE id=$1', [userId]).catch(() => {});
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
