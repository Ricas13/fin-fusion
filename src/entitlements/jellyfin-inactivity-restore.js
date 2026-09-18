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
    const entitlement = await subscriptionState.liveFreeJellyfinSubscription(
        customerId,
        { client, includeBlocked: true }
    );
    if (!entitlement) {
        return {
            eligible: false,
            reason: 'no_live_free_jellyfin_entitlement',
            entitlement: null,
            sourceKey: null,
            inactivityHold: null
        };
    }

    const sourceKey = `plan:${entitlement.plan_id}`;
    const hold = await db.query(`
        SELECT id,source_key,reason,created_at
        FROM customer_access_holds
        WHERE customer_id=$1
          AND hold_type=$2
          AND source_key=$3
          AND released_at IS NULL
          AND (
            metadata->>'subscriptionId'=$4::text
            OR (
              metadata->>'subscriptionId' IS NULL
              AND created_at>=$5::timestamptz
            )
          )
        ORDER BY created_at,id
        LIMIT 1
        ${lock ? 'FOR UPDATE' : ''}
    `, [
        customerId,
        HOLD_TYPE,
        sourceKey,
        entitlement.subscription_id,
        entitlement.subscription_created_at
    ]);

    if (!hold.rowCount) {
        return {
            eligible: false,
            reason: 'no_active_inactivity_hold',
            entitlement,
            sourceKey,
            inactivityHold: null
        };
    }

    if (entitlement.admin_jellyfin_removed) {
        return {
            eligible: false,
            reason: 'admin_removed',
            entitlement,
            sourceKey,
            inactivityHold: hold.rows[0]
        };
    }

    const otherBlocker = await db.query(`
        SELECT hold_type,source_key
        FROM customer_access_holds
        WHERE customer_id=$1
          AND released_at IS NULL
          AND NOT (hold_type=$2 AND source_key=$3)
        LIMIT 1
    `, [customerId, HOLD_TYPE, sourceKey]);
    if (otherBlocker.rowCount) {
        return {
            eligible: false,
            reason: 'other_access_blocker',
            entitlement,
            sourceKey,
            inactivityHold: hold.rows[0],
            otherBlocker: otherBlocker.rows[0]
        };
    }

    return {
        eligible: true,
        reason: null,
        entitlement,
        sourceKey,
        inactivityHold: hold.rows[0]
    };
}

// Compatibility helpers retained for older callers. The current present/deleted
// lifecycle no longer needs a separate restore-pending ledger.
function isPendingAdminReconcile() {
    return false;
}

async function markReconcileComplete() {
    return undefined;
}

async function restoreDisabledFreeAccess(customerId, { actorUserId = null, reconcile } = {}) {
    if (typeof reconcile !== 'function') {
        throw new Error('A Jellyfin reconciliation owner is required.');
    }

    const prepared = await transaction(async client => {
        const customer = await client.query(
            'SELECT id FROM customers WHERE id=$1 FOR UPDATE',
            [customerId]
        );
        if (!customer.rowCount) throw new Error('Customer not found.');

        const state = await restoreStatus(customerId, { client, lock: true });
        if (!state.eligible) {
            const messages = {
                no_live_free_jellyfin_entitlement: 'This customer does not have a live Free Server Jellyfin entitlement.',
                no_active_inactivity_hold: 'This customer is not currently removed by the Free Server inactivity policy.',
                admin_removed: 'Jellyfin access is explicitly removed by an administrator.',
                other_access_blocker: 'Another active access restriction must be resolved before Free Server access can be restored.'
            };
            throw Object.assign(
                new Error(messages[state.reason] || 'This Free Server access cannot be restored safely.'),
                { code: state.reason }
            );
        }

        const released = await accessHolds.releaseHold({
            customerId,
            type: HOLD_TYPE,
            sourceKey: state.sourceKey,
            actorUserId,
            resolutionReason: 'Free Server access explicitly restored'
        }, client);
        if (released !== 1) {
            throw new Error('The inactivity hold changed while the restore was being prepared.');
        }

        await client.query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.jellyfin.restore_free_access','customer',$2,$3::jsonb)
        `, [
            actorUserId,
            customerId,
            JSON.stringify({
                planId: state.entitlement.plan_id,
                sourceKey: state.sourceKey,
                action: 'release_inactivity_hold_and_reprovision'
            })
        ]);

        return {
            planId: state.entitlement.plan_id,
            subscriptionId: state.entitlement.subscription_id,
            sourceKey: state.sourceKey,
            restoredAt: new Date()
        };
    });

    let reconcileResult;
    let account;
    try {
        reconcileResult = await reconcile(customerId);

        const [hold, accountResult] = await Promise.all([
            query(`
                SELECT 1
                FROM customer_access_holds
                WHERE customer_id=$1
                  AND hold_type=$2
                  AND source_key=$3
                  AND released_at IS NULL
                LIMIT 1
            `, [customerId, HOLD_TYPE, prepared.sourceKey]),
            query(`
                SELECT id,server_id,jellyfin_user_id,jellyfin_username,created_at,access_lane_changed_at
                FROM jellyfin_accounts
                WHERE customer_id=$1
                  AND account_purpose='jellyfin'
                  AND access_lane='free'
                  AND disabled=FALSE
                ORDER BY created_at DESC
            `, [customerId])
        ]);

        if (hold.rowCount || accountResult.rowCount !== 1) {
            const error = new Error('Free Server restore did not converge to one present enabled account.');
            error.code = 'FREE_JELLYFIN_RESTORE_POSTCONDITION_FAILED';
            throw error;
        }
        account = accountResult.rows[0];
    } catch (error) {
        // Any failed restore, including a failure in a later service after the
        // Free Jellyfin account was already created, must fail closed. Restoring
        // the inactivity hold is mandatory; silently losing this rollback would
        // turn a reported restore failure into unintended active Free access.
        let rollbackHoldError = null;
        try {
            await accessHolds.addHold({
                customerId,
                type: HOLD_TYPE,
                sourceKey: prepared.sourceKey,
                reason: 'Free Server inactivity restore pending successful reprovisioning',
                actorUserId,
                metadata: {
                    subscriptionId: prepared.subscriptionId,
                    restoreReconcileFailed: true,
                    error: String(error?.message || error).slice(0, 500)
                }
            });
        } catch (holdError) {
            rollbackHoldError = holdError;
        }

        // If the hold was restored, immediately run the canonical reconciler
        // again with that hold active. The first reconcile may have created the
        // Free account before a later Stremio/Emby/Discord step failed; this
        // compensation removes that transient access instead of waiting for a
        // future worker retry. A later explicit admin/permanent authority is
        // still respected because the canonical reconciler owns that decision.
        let rollbackReconcileError = null;
        if (!rollbackHoldError) {
            try {
                await reconcile(customerId);
            } catch (reconcileError) {
                rollbackReconcileError = reconcileError;
            }
        }

        await query(`
            INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
            VALUES($1,'admin.customer.jellyfin.restore_free_access_failed','customer',$2,$3::jsonb)
        `, [
            actorUserId,
            customerId,
            JSON.stringify({
                planId: prepared.planId,
                error: String(error?.message || error).slice(0, 500),
                rollbackHoldError: rollbackHoldError
                    ? String(rollbackHoldError?.message || rollbackHoldError).slice(0, 500)
                    : null,
                rollbackReconcileError: rollbackReconcileError
                    ? String(rollbackReconcileError?.message || rollbackReconcileError).slice(0, 500)
                    : null
            })
        ]).catch(() => {});

        if (rollbackHoldError) {
            const rollbackFailure = new Error(
                `Free Server restore failed and its inactivity hold could not be restored: ${String(rollbackHoldError?.message || rollbackHoldError).slice(0, 300)}`
            );
            rollbackFailure.code = 'FREE_JELLYFIN_RESTORE_ROLLBACK_FAILED';
            rollbackFailure.cause = error;
            throw rollbackFailure;
        }
        throw error;
    }

    return {
        restored: true,
        enabled: true,
        blocked: false,
        account,
        planId: prepared.planId,
        sourceKey: prepared.sourceKey,
        restoredAt: prepared.restoredAt,
        reconcileResult
    };
}

module.exports = {
    HOLD_TYPE,
    restoreStatus,
    restoreDisabledFreeAccess,
    isPendingAdminReconcile,
    markReconcileComplete
};
