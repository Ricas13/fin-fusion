'use strict';

// The policy/Jellyfin mechanics remain in provisioning-core.  This facade owns
// entitlement and access-state semantics so every caller observes the same
// composable holds and effective-subscription rules.
const core = require('./provisioning-core');
const { query, transaction } = require('../db');
const subscriptionState = require('../entitlements/subscription-state');
const accessHolds = require('../entitlements/access-holds');

async function currentEntitlement(customerId) {
    return subscriptionState.effectiveSubscription(customerId);
}

async function syncAccess(customerId) {
    await accessHolds.syncLegacySummary(customerId);
}

async function reconcileCustomer(customerId) {
    await syncAccess(customerId);
    return core.reconcileCustomer(customerId);
}

async function reconcileAccount(accountId) {
    const account = await query('SELECT customer_id FROM jellyfin_accounts WHERE id=$1', [accountId]);
    if (account.rowCount) await syncAccess(account.rows[0].customer_id);
    return core.reconcileAccount(accountId);
}

function adminHoldType(reason) {
    if (reason === 'disabled') return 'admin_disabled';
    if (reason === 'suspended') return 'admin_suspended';
    return 'admin_hold';
}

async function holdAccess(customerId, reason = 'suspended', actorUserId = null) {
    const type = adminHoldType(String(reason || 'suspended'));
    await accessHolds.addHold({
        customerId,
        type,
        sourceKey: 'admin',
        reason: String(reason || type).slice(0, 500),
        actorUserId
    });
    return reconcileCustomer(customerId);
}

async function releaseAccess(customerId, actorUserId = null) {
    // Deliberately release only administrator holds. Billing, reseller and
    // policy holds are independent and survive an admin clicking Enable.
    await accessHolds.releaseAllAdminHolds(customerId, actorUserId);
    return reconcileCustomer(customerId);
}

async function expireSubscriptionsAndReconcile() {
    const expired = await transaction(async client => {
        const rows = await client.query(`
            WITH expired AS (
                UPDATE subscriptions
                SET status='expired',updated_at=NOW()
                WHERE superseded_by IS NULL
                  AND status IN ('active','trialing','past_due','paused')
                  AND current_period_end<=NOW()
                RETURNING customer_id
            ) SELECT DISTINCT customer_id FROM expired
        `);
        return rows.rows.map(row => row.customer_id);
    });
    for (const customerId of expired) {
        try { await reconcileCustomer(customerId); }
        catch (error) { console.error(`Entitlement reconcile failed for ${customerId}:`, error.message); }
    }
    return expired.length;
}

module.exports = {
    ...core,
    currentEntitlement,
    reconcileCustomer,
    reconcileAccount,
    holdAccess,
    releaseAccess,
    expireSubscriptionsAndReconcile
};
