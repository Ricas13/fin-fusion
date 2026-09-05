'use strict';

const { query, transaction } = require('../db');
const accessHolds = require('./access-holds');
const subscriptionState = require('./subscription-state');

const HOLD_TYPE = 'inactivity_policy';

function runner(client) {
    return client || { query };
}

function isPendingAdminReconcile(row) {
    return row?.metadata?.restoredReason === 'admin_reenable'
        && row?.metadata?.explicitRestore === true
        && row?.metadata?.reenableReconcilePending === true;
}

async function restoreStatus(customerId, { client = null, lock = false } = {}) {
    const db = runner(client);
    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(customerId, { client, includeBlocked: true });
    if (!entitlement) {
        return { eligible: false, reason: 'no_live_free_jellyfin_entitlement', entitlement: null, sourceKey: null, inactivityHold: null };
    }

    const sourceKey = `plan:${entitlement.plan_id}`;
    const holdSql = `
        SELECT id,source_key,reason,created_at
        FROM customer_access_holds
        WHERE customer_id=$1 AND hold_type=$2 AND source_key=$3 AND released_at IS NULL
        ORDER BY created_at,id
        LIMIT 1
        ${lock ? 'FOR UPDATE' : ''}
    `;
    const hold = await db.query(holdSql, [customerId, HOLD_TYPE, sourceKey]);
    if (!hold.rowCount) {
        return { eligible: false, reason: 'no_active_inactivity_hold', entitlement, sourceKey, inactivityHold: null };
    }

    return {
        eligible: true,
        reason: null,
        entitlement,
        sourceKey,
        inactivityHold: hold.rows[0]
    };
}

async function markReconcileComplete(lifecycleIds = [], actorUserId = null) {
    if (!lifecycleIds.length) return;
    await query(`
        UPDATE jellyfin_account_lifecycle
        SET metadata=metadata||$2::jsonb,updated_at=NOW()
        WHERE id=ANY($1::bigint[])
    `, [lifecycleIds, JSON.stringify({
        reenableReconcilePending: false,
        reenableReconciledAt: new Date().toISOString(),
        reenableReconciledBy: actorUserId
    })]);
}

// Historical API name retained for route compatibility. There is no disabled
// account to toggle anymore: admin restoration releases only the inactivity
// hold, then canonical reconciliation provisions a new enabled Free account.
async function restoreDisabledFreeAccess(customerId, { actorUserId = null, reconcile } = {}) {
    if (typeof reconcile !== 'function') throw new Error('A Jellyfin reconciliation owner is required.');

    const prepared = await transaction(async client => {
        const customer = await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [customerId]);
        if (!customer.rowCount) throw new Error('Customer not found.');

        const state = await restoreStatus(customerId, { client, lock: true });
        if (!state.eligible) {
            const messages = {
                no_live_free_jellyfin_entitlement: 'This customer does not have a live Free Server Jellyfin entitlement.',
                no_active_inactivity_hold: 'This customer is not currently removed by the Free Server inactivity policy.'
            };
            throw Object.assign(new Error(messages[state.reason] || 'This Free Server access cannot be restored safely.'), { code: state.reason });
        }

        const released = await accessHolds.releaseHold({
            customerId,
            type: HOLD_TYPE,
            sourceKey: state.sourceKey,
            actorUserId
        }, client);
        if (released !== 1) throw new Error('The inactivity hold changed while the restore was being prepared. Refresh the customer and try again.');

        // Close any pre-binary-lifecycle ledger entries without depending on a
        // jellyfin_accounts row. They are historical records only.
        const legacy = await client.query(`
            UPDATE jellyfin_account_lifecycle
            SET restored_at=COALESCE(restored_at,NOW()),
                metadata=metadata||$3::jsonb,
                updated_at=NOW()
            WHERE customer_id=$1 AND category='free' AND deleted_at IS NULL
              AND (metadata->>'planId'=$2::text OR metadata->>'planId' IS NULL)
            RETURNING id
        `, [customerId, state.entitlement.plan_id, JSON.stringify({
            restoredReason: 'admin_reenable',
            explicitRestore: true,
            actorUserId,
            binaryLifecycleReprovision: true
        })]);

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.jellyfin.restore_free_access','customer',$2,$3::jsonb)
        `, [actorUserId, customerId, JSON.stringify({
            planId: state.entitlement.plan_id,
            sourceKey: state.sourceKey,
            lifecycle: 'present_or_deleted',
            action: 'release_inactivity_hold_and_reprovision'
        })]);

        return {
            planId: state.entitlement.plan_id,
            sourceKey: state.sourceKey,
            lifecycleIds: legacy.rows.map(row => row.id),
            restoredAt: new Date()
        };
    });

    let reconcileResult;
    try {
        reconcileResult = await reconcile(customerId);
        await markReconcileComplete(prepared.lifecycleIds, actorUserId);
    } catch (error) {
        // Recreate the hold if reprovisioning failed so a broken remote server
        // cannot accidentally make the customer count as restored.
        await accessHolds.addHold({
            customerId,
            type: HOLD_TYPE,
            sourceKey: prepared.sourceKey,
            reason: 'Free Server inactivity restore pending successful reprovisioning',
            actorUserId,
            metadata: { restoreReconcileFailed: true, error: String(error?.message || error).slice(0, 500) }
        }).catch(() => {});
        await query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.jellyfin.restore_free_access_failed','customer',$2,$3::jsonb)
        `, [actorUserId, customerId, JSON.stringify({
            planId: prepared.planId,
            error: String(error?.message || error).slice(0, 500)
        })]).catch(() => {});
        throw error;
    }

    const [remainingHolds, account] = await Promise.all([
        accessHolds.activeHolds(customerId),
        query(`
            SELECT id,server_id,jellyfin_user_id,jellyfin_username
            FROM jellyfin_accounts
            WHERE customer_id=$1 AND account_purpose='jellyfin' AND access_lane='free'
            ORDER BY created_at DESC LIMIT 1
        `, [customerId])
    ]);
    const enabled = remainingHolds.length === 0 && account.rowCount === 1;
    if (!enabled) {
        const error = new Error('Free Server restore did not converge to one present enabled account.');
        error.code = 'FREE_JELLYFIN_RESTORE_POSTCONDITION_FAILED';
        throw error;
    }

    return {
        restored: true,
        resumed: false,
        enabled: true,
        blocked: false,
        remainingHolds: [],
        stillDisabled: [],
        account: account.rows[0],
        planId: prepared.planId,
        sourceKey: prepared.sourceKey,
        restoredAt: prepared.restoredAt,
        reconcileResult
    };
}

module.exports = { HOLD_TYPE, restoreStatus, restoreDisabledFreeAccess, isPendingAdminReconcile, markReconcileComplete };
