'use strict';

const { query, transaction } = require('../db');
const durableCreation = require('../jellyfin/durable-account-creation');
const compensation = require('../jellyfin/provisioning-compensation');
const provisioning = require('../jellyfin/resilient-provisioning');
const subscriptionState = require('../entitlements/subscription-state');

const STALE_MINUTES = 30;

function safeError(error) {
    return String(error?.message || error || 'Unknown creation-intent recovery failure')
        .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
        .slice(0, 800);
}

async function due({ limit = 25 } = {}) {
    const safeLimit = Math.max(1, Math.min(100, Number(limit) || 25));
    const result = await query(`
        SELECT i.*
        FROM jellyfin_account_creation_intents i
        JOIN jellyfin_servers s ON s.id=i.server_id
        WHERE i.updated_at <= NOW()-make_interval(mins=>$2)
        ORDER BY i.updated_at,i.created_at
        LIMIT $1
    `, [safeLimit, STALE_MINUTES]);
    return result.rows;
}

async function entitlementStillOwnsJellyfin(customerId) {
    const [primary, free] = await Promise.all([
        subscriptionState.effectiveSubscription(customerId, { includeBlocked: true }),
        subscriptionState.liveFreeJellyfinSubscription(customerId, { includeBlocked: true })
    ]);
    const primaryOwns = Boolean(primary && primary.admin_jellyfin_removed !== true);
    const freeOwns = Boolean(free && free.admin_jellyfin_removed !== true);
    return { owns: primaryOwns || freeOwns, primary, free };
}

async function removeAbandonedIntent(intent) {
    let remoteUserId = intent.remote_user_id || null;
    if (!remoteUserId && ['attempting', 'uncertain'].includes(String(intent.status))) {
        const remote = await durableCreation.findRemoteByName(intent.server_id, intent.username);
        remoteUserId = remote?.Id || null;
    }
    if (remoteUserId) {
        await compensation.removeCreatedUser({
            customerId: intent.customer_id,
            serverId: intent.server_id,
            userId: remoteUserId,
            stage: 'stale_creation_intent_recovery',
            originalError: new Error('Creation intent no longer has a current Jellyfin entitlement')
        });
    }
    await transaction(async client => {
        await client.query('DELETE FROM jellyfin_account_creation_intents WHERE id=$1', [intent.id]);
        await client.query(`DELETE FROM jellyfin_server_placement_leases
            WHERE customer_id=$1 AND server_id=$2`, [intent.customer_id, intent.server_id]);
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('jellyfin.creation_intent.abandoned_recovered','customer',$1,$2::jsonb)`, [
            intent.customer_id,
            JSON.stringify({
                intentId: intent.id,
                serverId: intent.server_id,
                username: intent.username,
                remoteUserId,
                priorStatus: intent.status
            })
        ]);
    });
    return { action: 'removed', remoteUserId };
}

async function recoverOne(intent) {
    // First give normal desired-state reconciliation the chance to adopt an
    // already-created remote account. That path is idempotent and retains the
    // durable intent until local persistence succeeds.
    const entitlement = await entitlementStillOwnsJellyfin(intent.customer_id);
    if (entitlement.owns) {
        await provisioning.reconcileCustomer(intent.customer_id);
        const remaining = await durableCreation.loadIntent(intent.customer_id, intent.server_id);
        return { action: remaining ? 'retry_pending' : 'adopted', remaining: Boolean(remaining) };
    }
    // No valid Jellyfin entitlement remains. Now it is safe to compensate any
    // orphaned remote user and release the capacity reservation.
    return removeAbandonedIntent(intent);
}

async function run({ limit = 25 } = {}) {
    const rows = await due({ limit });
    const summary = { total: rows.length, processed: rows.length, adopted: 0, removed: 0, pending: 0, failed: 0, failures: [] };
    for (const intent of rows) {
        try {
            const result = await recoverOne(intent);
            if (result.action === 'adopted') summary.adopted++;
            else if (result.action === 'removed') summary.removed++;
            else summary.pending++;
        } catch (error) {
            summary.failed++;
            summary.failures.push({ intentId: intent.id, customerId: intent.customer_id, serverId: intent.server_id, error: safeError(error) });
        }
    }
    if (summary.failed) summary.warning = `${summary.failed} stale Jellyfin creation intent${summary.failed === 1 ? '' : 's'} could not be recovered: ${summary.failures.slice(0, 3).map(x => x.error).join('; ')}`.slice(0, 1000);
    return summary;
}

module.exports = { STALE_MINUTES, safeError, due, entitlementStillOwnsJellyfin, removeAbandonedIntent, recoverOne, run };
