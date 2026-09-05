'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const accessHolds = require('../src/entitlements/access-holds');
const restore = require('../src/entitlements/jellyfin-inactivity-restore');

(async () => {
    const suffix = crypto.randomBytes(5).toString('hex');
    const created = { customers: [], users: [], servers: [] };

    async function fixture(label) {
        const user = await query(`INSERT INTO app_users(username,password_hash,role,active,email_verified_at) VALUES($1,'test-hash','customer',TRUE,NOW()) RETURNING id`, [`restore_${label}_${suffix}`]);
        created.users.push(user.rows[0].id);
        const customer = await query(`INSERT INTO customers(user_id,display_name,automation_protected) VALUES($1,$2,FALSE) RETURNING id`, [user.rows[0].id, `Restore ${label} ${suffix}`]);
        const customerId = customer.rows[0].id;
        created.customers.push(customerId);

        const plan = await query(`SELECT id FROM plans WHERE is_free_tier=TRUE AND COALESCE(is_addon,FALSE)=FALSE ORDER BY created_at,id LIMIT 1`);
        assert.strictEqual(plan.rowCount, 1, 'clean install must contain the canonical Free tier plan');
        const planId = plan.rows[0].id;

        const server = await query(`
            INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted,enabled,allow_new_users,paid_enabled,priority,max_users,health_status,last_health_check)
            VALUES($1,$2,'free','https://restore.example.test','key',TRUE,TRUE,TRUE,10,100,'healthy',NOW()) RETURNING id
        `, [`Restore ${label} ${suffix}`, `restore-${label}-${suffix}`]);
        const serverId = server.rows[0].id;
        created.servers.push(serverId);
        await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3000 days')`, [customerId, planId]);
        const hold = await accessHolds.addHold({
            customerId,
            type: 'inactivity_policy',
            sourceKey: `plan:${planId}`,
            reason: 'Free-plan Jellyfin usage rule: DB smoke'
        });
        return { customerId, planId, serverId, holdId: hold.id };
    }

    try {
        const invariant = await fixture('invariant');
        await assert.rejects(
            query(`
                INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary)
                VALUES($1,$2,$3,$4,TRUE,'jellyfin','free',TRUE)
            `, [invariant.customerId, invariant.serverId, `disabled-${suffix}`, `Disabled_${suffix}`]),
            error => String(error?.code || '') === '23514',
            'database must reject disabled Jellyfin account rows'
        );

        const invariantAccount = await query(`
            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary)
            VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE) RETURNING id
        `, [invariant.customerId, invariant.serverId, `enabled-${suffix}`, `Enabled_${suffix}`]);
        await assert.rejects(
            query(`
                INSERT INTO jellyfin_policy_reconciliation(jellyfin_account_id,customer_id,status,desired_disabled)
                VALUES($1,$2,'running',TRUE)
            `, [invariantAccount.rows[0].id, invariant.customerId]),
            error => String(error?.code || '') === '23514',
            'a true desired-disabled reconciliation target must never be accepted'
        );

        const normal = await fixture('normal');
        let newAccountId = null;
        const normalResult = await restore.restoreDisabledFreeAccess(normal.customerId, {
            actorUserId: null,
            reconcile: async customerId => {
                const holds = await accessHolds.activeHolds(customerId);
                assert(!holds.some(row => row.hold_type === 'inactivity_policy'), 'reconcile must run only after the matching inactivity hold is released');
                const account = await query(`
                    INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary)
                    VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE) RETURNING id
                `, [customerId, normal.serverId, `remote-normal-${suffix}`, `Free_normal_${suffix}`]);
                newAccountId = account.rows[0].id;
                return { active: true, account: account.rows[0] };
            }
        });
        assert.strictEqual(normalResult.enabled, true, 'Free restore must finish with one present enabled account');
        assert(newAccountId, 'restore reconciliation must provision a replacement account');
        assert.strictEqual((await query(`SELECT released_at FROM customer_access_holds WHERE id=$1`, [normal.holdId])).rows[0].released_at != null, true, 'matching inactivity hold must be released');
        const stored = await query(`SELECT disabled FROM jellyfin_accounts WHERE id=$1`, [newAccountId]);
        assert.strictEqual(stored.rowCount, 1);
        assert.strictEqual(stored.rows[0].disabled, false, 'restored account must be enabled');

        const retry = await fixture('retry');
        await assert.rejects(
            restore.restoreDisabledFreeAccess(retry.customerId, {
                actorUserId: null,
                reconcile: async () => { throw new Error('simulated Jellyfin outage'); }
            }),
            /simulated Jellyfin outage/,
            'a reprovisioning failure must surface to the operator'
        );
        const retryHolds = await accessHolds.activeHolds(retry.customerId);
        assert(retryHolds.some(row => row.hold_type === 'inactivity_policy'), 'failed reprovisioning must restore the inactivity hold');
        assert.strictEqual((await query(`SELECT COUNT(*)::int count FROM jellyfin_accounts WHERE customer_id=$1`, [retry.customerId])).rows[0].count, 0, 'failed restore must not leave a disabled or partial account');

        console.log('admin jellyfin present-or-deleted db smoke: ok');
    } finally {
        for (const customerId of created.customers.reverse()) await query('DELETE FROM customers WHERE id=$1', [customerId]).catch(() => {});
        for (const serverId of created.servers.reverse()) await query('DELETE FROM jellyfin_servers WHERE id=$1', [serverId]).catch(() => {});
        for (const userId of created.users.reverse()) await query('DELETE FROM app_users WHERE id=$1', [userId]).catch(() => {});
    }
})().finally(() => getPool().end()).catch(error => {
    console.error(error);
    process.exit(1);
});
