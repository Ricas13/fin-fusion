'use strict';

const { query, transaction } = require('../db');
const accessHolds = require('./access-holds');
const subscriptionState = require('./subscription-state');

const HOLD_TYPE = 'inactivity_policy';

function runner(client) {
    return client || { query };
}

async function restoreStatus(customerId, { client = null, lock = false } = {}) {
    const db = runner(client);
    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(customerId, { client, includeBlocked: true });
    if (!entitlement) {
        return { eligible: false, reason: 'no_live_free_jellyfin_entitlement', entitlement: null, sourceKey: null, disabledAccounts: [], lifecycleRows: [] };
    }

    const sourceKey = `plan:${entitlement.plan_id}`;
    const accountSql = `
        SELECT id,server_id,jellyfin_user_id,jellyfin_username,disabled
        FROM jellyfin_accounts
        WHERE customer_id=$1 AND account_purpose='jellyfin' AND access_lane='free' AND disabled=TRUE
        ORDER BY is_primary DESC,created_at,id
        ${lock ? 'FOR UPDATE' : ''}
    `;
    const holdSql = `
        SELECT id,source_key,reason,created_at
        FROM customer_access_holds
        WHERE customer_id=$1 AND hold_type=$2 AND source_key=$3 AND released_at IS NULL
        ORDER BY created_at,id
        LIMIT 1
        ${lock ? 'FOR UPDATE' : ''}
    `;
    const accounts = await db.query(accountSql, [customerId]);
    const hold = await db.query(holdSql, [customerId, HOLD_TYPE, sourceKey]);

    let lifecycleRows = [];
    if (accounts.rowCount) {
        const accountIds = accounts.rows.map(row => row.id);
        const lifecycle = await db.query(`
            SELECT id,account_id,disabled_at,delete_after,deleted_at,restored_at,metadata
            FROM jellyfin_account_lifecycle
            WHERE customer_id=$1 AND category='free' AND account_id=ANY($2::uuid[])
              AND deleted_at IS NULL AND restored_at IS NULL
            ORDER BY disabled_at DESC,id
            ${lock ? 'FOR UPDATE' : ''}
        `, [customerId, accountIds]);
        lifecycleRows = lifecycle.rows;
    }

    if (!accounts.rowCount) {
        return { eligible: false, reason: 'no_disabled_free_jellyfin_account', entitlement, sourceKey, disabledAccounts: [], lifecycleRows };
    }
    if (!hold.rowCount) {
        return { eligible: false, reason: 'no_active_inactivity_hold', entitlement, sourceKey, disabledAccounts: accounts.rows, lifecycleRows };
    }
    if (!lifecycleRows.length) {
        return { eligible: false, reason: 'no_pending_free_lifecycle', entitlement, sourceKey, disabledAccounts: accounts.rows, lifecycleRows };
    }

    return {
        eligible: true,
        reason: null,
        entitlement,
        sourceKey,
        inactivityHold: hold.rows[0],
        disabledAccounts: accounts.rows,
        lifecycleRows
    };
}

async function restoreDisabledFreeAccess(customerId, { actorUserId = null, reconcile } = {}) {
    if (typeof reconcile !== 'function') throw new Error('A Jellyfin reconciliation owner is required.');

    const prepared = await transaction(async client => {
        const customer = await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
        if (!customer.rowCount) throw new Error('Customer not found.');

        const state = await restoreStatus(customerId, { client, lock: true });
        if (!state.eligible) {
            const messages = {
                no_live_free_jellyfin_entitlement: 'This customer does not have a live Free Server Jellyfin entitlement.',
                no_disabled_free_jellyfin_account: 'There is no disabled Free Server Jellyfin account to restore.',
                no_active_inactivity_hold: 'The disabled account is not owned by the Free Server inactivity policy. No unrelated access block was changed.',
                no_pending_free_lifecycle: 'The disabled account has no pending Free Server lifecycle record. No access state was changed.'
            };
            throw Object.assign(new Error(messages[state.reason] || 'This Jellyfin account cannot be restored safely.'), { code: state.reason });
        }

        const released = await accessHolds.releaseHold({
            customerId,
            type: HOLD_TYPE,
            sourceKey: state.sourceKey,
            actorUserId
        }, client);
        if (released !== 1) throw new Error('The inactivity hold changed while the restore was being prepared. Refresh the customer and try again.');

        const lifecycleIds = state.lifecycleRows.map(row => row.id);
        const restored = await client.query(`
            UPDATE jellyfin_account_lifecycle
            SET restored_at=NOW(),
                metadata=metadata||$2::jsonb,
                updated_at=NOW()
            WHERE id=ANY($1::bigint[]) AND restored_at IS NULL AND deleted_at IS NULL
            RETURNING id,account_id,restored_at
        `, [lifecycleIds, JSON.stringify({ restoredReason: 'admin_reenable', explicitRestore: true, actorUserId })]);
        if (!restored.rowCount) throw new Error('The Free Server lifecycle changed while the restore was being prepared. Refresh and try again.');

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.jellyfin.reenable','customer',$2,$3::jsonb)
        `, [actorUserId, customerId, JSON.stringify({
            planId: state.entitlement.plan_id,
            sourceKey: state.sourceKey,
            accountIds: state.disabledAccounts.map(row => row.id),
            lifecycleIds: restored.rows.map(row => row.id),
            normalInactivityRulesResume: true
        })]);

        return {
            planId: state.entitlement.plan_id,
            sourceKey: state.sourceKey,
            accountIds: state.disabledAccounts.map(row => row.id),
            restoredAt: restored.rows[0]?.restored_at || new Date()
        };
    });

    let reconcileResult;
    try {
        reconcileResult = await reconcile(customerId);
    } catch (error) {
        await query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.jellyfin.reenable_reconcile_failed','customer',$2,$3::jsonb)
        `, [actorUserId, customerId, JSON.stringify({ planId: prepared.planId, error: String(error?.message || error).slice(0, 500) })]).catch(() => {});
        throw error;
    }

    const [remainingHolds, accounts] = await Promise.all([
        accessHolds.activeHolds(customerId),
        query(`SELECT id,disabled FROM jellyfin_accounts WHERE id=ANY($1::uuid[]) ORDER BY id`, [prepared.accountIds])
    ]);
    const stillDisabled = accounts.rows.filter(row => row.disabled === true).map(row => row.id);

    return {
        restored: true,
        enabled: remainingHolds.length === 0 && stillDisabled.length === 0,
        blocked: remainingHolds.length > 0,
        remainingHolds: remainingHolds.map(row => ({ type: row.hold_type, sourceKey: row.source_key, reason: row.reason })),
        stillDisabled,
        planId: prepared.planId,
        sourceKey: prepared.sourceKey,
        restoredAt: prepared.restoredAt,
        reconcileResult
    };
}

module.exports = { HOLD_TYPE, restoreStatus, restoreDisabledFreeAccess };
