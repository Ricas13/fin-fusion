'use strict';

const { query, transaction } = require('../db');
const durableCreation = require('../jellyfin/durable-account-creation');
const compensation = require('../jellyfin/provisioning-compensation');
const provisioning = require('../jellyfin/resilient-provisioning');
const subscriptionState = require('../entitlements/subscription-state');
const serviceAdminControl = require('../entitlements/service-admin-control');

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

async function entitlementStillOwnsJellyfin(customerId, { client = null } = {}) {
    const [primary, free, admin] = await Promise.all([
        subscriptionState.effectiveSubscription(customerId, { client, includeBlocked: true }),
        subscriptionState.liveFreeJellyfinSubscription(customerId, { client, includeBlocked: true }),
        serviceAdminControl.state(customerId, 'jellyfin', { client })
    ]);
    // Explicit administrator authority always wins. In particular, never let
    // orphan cleanup delete a remote identity while admin_present is active,
    // even during subscription churn when no ordinary entitlement row is live.
    // admin_present grants access. admin_server_pin is placement-only and must
    // never keep an account/intention alive after the underlying entitlement ends.
    const adminOwns = admin?.mode === 'admin_present';
    const adminRemoved = admin?.mode === 'admin_removed';
    const primaryOwns = Boolean(primary && primary.admin_jellyfin_removed !== true);
    const freeOwns = Boolean(free && free.admin_jellyfin_removed !== true);
    return { owns: adminOwns || (!adminRemoved && (primaryOwns || freeOwns)), primary, free, admin };
}

function entitlementOwnsLane(row) {
    return Boolean(row && row.admin_jellyfin_removed !== true);
}

function intentServerStillOwned(intent, authority) {
    if (!authority?.owns) return false;
    const serverId = String(intent?.server_id || '');
    if (!serverId) return false;
    if (authority.admin?.mode === 'admin_present') return true;
    if (authority.admin?.mode === 'admin_removed') return false;

    const lane = String(intent?.access_lane || '').trim();
    let entitlements;
    if (lane === 'free') entitlements = entitlementOwnsLane(authority.free) ? [authority.free] : [];
    else if (lane === 'primary') entitlements = entitlementOwnsLane(authority.primary) ? [authority.primary] : [];
    else {
        // Rolling-deploy compatibility: old intents have no lane. Preserve them
        // conservatively when any current Jellyfin lane could still own them.
        entitlements = [authority.primary, authority.free].filter(entitlementOwnsLane);
    }
    if (!entitlements.length) return false;

    // A server pin changes placement only. It is authoritative only while the
    // corresponding entitlement lane still exists.
    if (authority.admin?.mode === 'admin_server_pin') {
        return String(authority.admin.server_id || '') === serverId;
    }

    // A legacy entitlement without a persisted assignment cannot safely prove
    // that this intent is stale, so preserve the conservative behaviour.
    if (entitlements.some(row => !row.media_server_id)) return true;
    return entitlements.some(row => String(row.media_server_id) === serverId);
}

async function resolveLegacyIntentLane(intent, authority) {
    if (!intent || intent.access_lane) return intent;
    const primary = entitlementOwnsLane(authority?.primary);
    const free = entitlementOwnsLane(authority?.free);
    if (primary === free) return intent;
    const accessLane = free ? 'free' : 'primary';
    const updated = await query(`
        UPDATE jellyfin_account_creation_intents
        SET access_lane=$2,updated_at=NOW()
        WHERE id=$1 AND access_lane IS NULL
        RETURNING *
    `, [intent.id, accessLane]);
    if (updated.rowCount) {
        await query(`
            UPDATE jellyfin_server_placement_leases
            SET access_lane=COALESCE(access_lane,$3),updated_at=NOW()
            WHERE customer_id=$1 AND server_id=$2
        `, [intent.customer_id, intent.server_id, accessLane]).catch(() => {});
        return updated.rows[0];
    }
    return { ...intent, access_lane: accessLane };
}

async function removeAbandonedIntent(intent) {
    // Cheap preflight avoids taking a customer lock when authority has already
    // been restored. It is NOT the destructive decision: that is repeated while
    // holding the customer row lock below.
    const current = await entitlementStillOwnsJellyfin(intent.customer_id);
    if (intentServerStillOwned(intent, current)) return { action: 'preserved', reason: 'entitlement_or_admin_authority_restored' };

    let discoveredRemoteUserId = intent.remote_user_id || null;
    if (!discoveredRemoteUserId && ['attempting', 'uncertain'].includes(String(intent.status))) {
        const remote = await durableCreation.findRemoteByName(intent.server_id, intent.username);
        discoveredRemoteUserId = remote?.Id || null;
    }

    return transaction(async client => {
        // Every subscription/admin-authority mutation takes this customer-row
        // lock. Holding it across the destructive remote DELETE closes the race
        // where access could be restored after our last check but before Jellyfin
        // was called. Lock the intent too so another recovery/adoption cannot
        // consume it while this worker is deleting the remote identity.
        const customer = await client.query('SELECT id FROM customers WHERE id=$1 FOR UPDATE', [intent.customer_id]);
        const locked = await client.query('SELECT * FROM jellyfin_account_creation_intents WHERE id=$1 FOR UPDATE', [intent.id]);
        if (!locked.rowCount) return { action: 'preserved', reason: 'intent_already_resolved' };
        const liveIntent = locked.rows[0];

        if (customer.rowCount) {
            const authoritative = await entitlementStillOwnsJellyfin(intent.customer_id, { client });
            if (intentServerStillOwned(liveIntent, authoritative)) return { action: 'preserved', reason: 'entitlement_or_admin_authority_restored' };
        }

        let remoteUserId = liveIntent.remote_user_id || discoveredRemoteUserId || null;
        // If the intent changed while the preflight discovery was running, never
        // trust a remote id belonging to an older snapshot of the intent.
        if (String(liveIntent.username || '') !== String(intent.username || '')) remoteUserId = liveIntent.remote_user_id || null;

        if (remoteUserId) {
            await compensation.removeCreatedUser({
                customerId: liveIntent.customer_id,
                serverId: liveIntent.server_id,
                userId: remoteUserId,
                stage: 'stale_creation_intent_recovery',
                originalError: new Error('Creation intent no longer has a current Jellyfin entitlement')
            });
        }

        await client.query('DELETE FROM jellyfin_account_creation_intents WHERE id=$1', [liveIntent.id]);
        await client.query(`DELETE FROM jellyfin_server_placement_leases
            WHERE customer_id=$1 AND server_id=$2
              AND (access_lane IS NULL OR access_lane=$3)`, [
            liveIntent.customer_id,
            liveIntent.server_id,
            liveIntent.access_lane || null
        ]);
        await client.query(`INSERT INTO audit_log(action,entity_type,entity_id,metadata)
            VALUES('jellyfin.creation_intent.abandoned_recovered','customer',$1,$2::jsonb)`, [
            liveIntent.customer_id,
            JSON.stringify({
                intentId: liveIntent.id,
                serverId: liveIntent.server_id,
                username: liveIntent.username,
                remoteUserId,
                priorStatus: liveIntent.status,
                destructiveDecisionSerialized: true
            })
        ]);
        return { action: 'removed', remoteUserId };
    });
}

async function recoverOne(intent) {
    // First give normal desired-state reconciliation the chance to adopt an
    // already-created remote account. That path is idempotent and retains the
    // durable intent until local persistence succeeds.
    const entitlement = await entitlementStillOwnsJellyfin(intent.customer_id);
    intent = await resolveLegacyIntentLane(intent, entitlement);
    if (intentServerStillOwned(intent, entitlement)) {
        await provisioning.reconcileCustomer(intent.customer_id);
        const remaining = await durableCreation.loadIntent(intent.customer_id, intent.server_id);
        return { action: remaining ? 'retry_pending' : 'adopted', remaining: Boolean(remaining) };
    }
    // No valid Jellyfin entitlement or admin-present/server-pin authority remains.
    // Take the same per-customer reconciliation lock used by provisioning before
    // entering the destructive path. removeAbandonedIntent then repeats the
    // authority check under the customer-row transaction lock before DELETE.
    return provisioning.reconciliationLock.withCustomerReconciliationLock(
        intent.customer_id,
        () => removeAbandonedIntent(intent)
    );
}

async function run({ limit = 25 } = {}) {
    const rows = await due({ limit });
    const summary = { total: rows.length, processed: rows.length, adopted: 0, removed: 0, preserved: 0, pending: 0, failed: 0, failures: [] };
    for (const intent of rows) {
        try {
            const result = await recoverOne(intent);
            if (result.action === 'adopted') summary.adopted++;
            else if (result.action === 'removed') summary.removed++;
            else if (result.action === 'preserved') summary.preserved++;
            else summary.pending++;
        } catch (error) {
            summary.failed++;
            summary.failures.push({ intentId: intent.id, customerId: intent.customer_id, serverId: intent.server_id, error: safeError(error) });
        }
    }
    if (summary.failed) summary.warning = `${summary.failed} stale Jellyfin creation intent${summary.failed === 1 ? '' : 's'} could not be recovered: ${summary.failures.slice(0, 3).map(x => x.error).join('; ')}`.slice(0, 1000);
    return summary;
}

module.exports = { STALE_MINUTES, safeError, due, entitlementStillOwnsJellyfin, entitlementOwnsLane, intentServerStillOwned, resolveLegacyIntentLane, removeAbandonedIntent, recoverOne, run };
