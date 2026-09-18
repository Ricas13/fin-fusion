'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { query, getPool } = require('../src/db');
const accessHolds = require('../src/entitlements/access-holds');
const restore = require('../src/entitlements/jellyfin-inactivity-restore');
const subscriptionState = require('../src/entitlements/subscription-state');
const inactivityHoldReconciliation = require('../src/entitlements/inactivity-hold-reconciliation');

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
        const subscription = await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end) VALUES($1,$2,'active','free_claim',NOW()-INTERVAL '30 days',NOW()+INTERVAL '3000 days') RETURNING id,created_at`, [customerId, planId]);
        const hold = await accessHolds.addHold({
            customerId,
            type: 'inactivity_policy',
            sourceKey: `plan:${planId}`,
            reason: 'Free-plan Jellyfin usage rule: DB smoke'
        });
        return { customerId, planId, serverId, holdId: hold.id, subscriptionId: subscription.rows[0].id };
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
                INSERT INTO jellyfin_policy_drift(jellyfin_account_id,customer_id,server_id,status,desired_disabled)
                VALUES($1,$2,$3,'unknown',TRUE)
            `, [invariantAccount.rows[0].id, invariant.customerId, invariant.serverId]),
            error => String(error?.code || '') === '23514',
            'a true desired-disabled policy target must never be accepted'
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
        const retryHold = retryHolds.find(row => row.hold_type === 'inactivity_policy');
        assert(retryHold, 'failed reprovisioning must restore the inactivity hold');
        assert.strictEqual(String(retryHold.metadata?.subscriptionId || ''), String(retry.subscriptionId), 'restored hold must stay bound to the exact failed Free subscription episode');
        assert.strictEqual((await query(`SELECT COUNT(*)::int count FROM jellyfin_accounts WHERE customer_id=$1`, [retry.customerId])).rows[0].count, 0, 'failed restore must not leave a disabled or partial account');

        const postcondition = await fixture('postcondition');
        await assert.rejects(
            restore.restoreDisabledFreeAccess(postcondition.customerId, {
                actorUserId: null,
                reconcile: async () => ({ active:false })
            }),
            error => error?.code === 'FREE_JELLYFIN_RESTORE_POSTCONDITION_FAILED',
            'a reconcile that returns without one Free account must fail the restore'
        );
        const postconditionHolds = await accessHolds.activeHolds(postcondition.customerId);
        assert(postconditionHolds.some(row => row.hold_type === 'inactivity_policy'), 'failed restore postcondition must restore the inactivity hold');

        // Reconciliation is multi-service. A later service can fail after the
        // Free Jellyfin lane was already recreated. The restore owner must put
        // the hold back and immediately compensate under that hold so the
        // failed operation does not leave transient Free access active.
        const partial = await fixture('partial-reconcile');
        let partialCalls = 0;
        await assert.rejects(
            restore.restoreDisabledFreeAccess(partial.customerId, {
                actorUserId: null,
                reconcile: async customerId => {
                    partialCalls += 1;
                    const holds = await accessHolds.activeHolds(customerId);
                    if (partialCalls === 1) {
                        assert(!holds.some(row => row.hold_type === 'inactivity_policy'), 'first restore reconcile must run after releasing the inactivity hold');
                        await query(`
                            INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username,disabled,account_purpose,access_lane,is_primary)
                            VALUES($1,$2,$3,$4,FALSE,'jellyfin','free',TRUE)
                        `, [customerId, partial.serverId, `remote-partial-${suffix}`, `Free_partial_${suffix}`]);
                        throw new Error('simulated later-service failure');
                    }
                    assert(holds.some(row => row.hold_type === 'inactivity_policy'), 'compensation reconcile must run with the inactivity hold restored');
                    await query(`DELETE FROM jellyfin_accounts WHERE customer_id=$1 AND access_lane='free'`, [customerId]);
                    return { active:false, status:'blocked' };
                }
            }),
            /simulated later-service failure/,
            'a later-service failure must still surface after compensation'
        );
        assert.strictEqual(partialCalls, 2, 'failed restore must immediately run one compensating reconcile');
        assert.strictEqual((await query(`SELECT COUNT(*)::int count FROM jellyfin_accounts WHERE customer_id=$1 AND access_lane='free'`, [partial.customerId])).rows[0].count, 0, 'compensation must remove a Free account created by the failed restore');
        const partialHolds = await accessHolds.activeHolds(partial.customerId);
        assert(partialHolds.some(row => row.hold_type === 'inactivity_policy' && String(row.metadata?.subscriptionId || '') === String(partial.subscriptionId)), 'compensation must leave the exact inactivity hold active');

        // A hold belongs to one removal episode, not forever to the canonical
        // Free plan. A later Free subscription for the same plan must start clean.
        const stale = await fixture('stale-hold');
        await query(`UPDATE subscriptions SET status='expired',current_period_end=NOW()-INTERVAL '1 minute' WHERE id=$1`,[stale.subscriptionId]);
        const replacementSubscription = await query(`
            INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
            VALUES($1,$2,'active','free_claim',NOW(),NOW()+INTERVAL '3000 days')
            RETURNING id
        `,[stale.customerId,stale.planId]);
        const replacementEntitlement = await subscriptionState.liveFreeJellyfinSubscription(stale.customerId,{includeBlocked:true});
        assert.strictEqual(String(replacementEntitlement.subscription_id),String(replacementSubscription.rows[0].id),'new Free subscription must become canonical');
        assert.strictEqual(Boolean(replacementEntitlement.blocked),false,'an inactivity hold created before the new Free subscription must not block the new allocation');
        const releasedStale = await inactivityHoldReconciliation.releaseObsoleteForCustomer(stale.customerId);
        assert.strictEqual(releasedStale,1,'customer reconciliation must retire the previous Free allocation hold');
        assert((await query(`SELECT released_at FROM customer_access_holds WHERE id=$1`,[stale.holdId])).rows[0].released_at,'previous allocation hold must be released');

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
