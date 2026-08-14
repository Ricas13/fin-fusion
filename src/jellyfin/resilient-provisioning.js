'use strict';

const { query, transaction } = require('../db');
const base = require('./provisioning');
const control = require('./reconciliation-control');

function stateDetail(entitlement, outcome) {
    const account = outcome?.account || null;
    return {
        subscriptionId: entitlement?.subscription_id || null,
        planId: entitlement?.plan_id || null,
        accountId: account?.id || null,
        serverId: account?.server_id || null,
        result: {
            active: Boolean(outcome?.active),
            planCode: entitlement?.code || null,
            jellyfinAccountId: account?.id || null,
            serverId: account?.server_id || null,
            reconciledAt: new Date().toISOString()
        }
    };
}

async function reconcileCustomer(customerId) {
    const entitlement = await base.currentEntitlement(customerId);
    await control.markCustomerRunning(customerId, entitlement);
    try {
        const outcome = await base.reconcileCustomer(customerId);
        await control.markCustomerHealthy(customerId, stateDetail(entitlement, outcome));
        return outcome;
    } catch (error) {
        const classified = control.classifyError(error);
        await control.markCustomerProblem(customerId, classified.status, error, stateDetail(entitlement, null));
        throw error;
    }
}

async function reconcileAccount(accountId) {
    const result = await query('SELECT customer_id FROM jellyfin_accounts WHERE id=$1', [accountId]);
    if (!result.rowCount) throw new Error('Jellyfin account not found');
    return reconcileCustomer(result.rows[0].customer_id);
}

async function holdAccess(customerId, reason) {
    await query('UPDATE customers SET access_paused_at=NOW(),access_hold_reason=$2 WHERE id=$1', [customerId, reason]);
    return reconcileCustomer(customerId);
}

async function releaseAccess(customerId) {
    await query('UPDATE customers SET access_paused_at=NULL,access_hold_reason=NULL WHERE id=$1', [customerId]);
    return reconcileCustomer(customerId);
}

async function setJellyfinPassword(customerId, accountId, newPassword) {
    const result = await base.setJellyfinPassword(customerId, accountId, newPassword);
    await query(`
        UPDATE jellyfin_accounts
        SET password_reset_required=FALSE,updated_at=NOW()
        WHERE id=$1 AND customer_id=$2
    `, [accountId, customerId]);
    return result;
}

async function expireSubscriptionsAndReconcile() {
    const expired = await transaction(async client => {
        const rows = await client.query(`
            WITH expired AS (
                UPDATE subscriptions
                SET status='expired',updated_at=NOW()
                WHERE status IN ('active','trialing','past_due') AND current_period_end <= NOW()
                RETURNING customer_id
            )
            SELECT DISTINCT customer_id FROM expired
        `);
        return rows.rows.map(row => row.customer_id);
    });
    for (const customerId of expired) {
        try {
            await reconcileCustomer(customerId);
        } catch (error) {
            console.error(`Entitlement reconcile failed for ${customerId}:`, error.message);
        }
    }
    return expired.length;
}

module.exports = {
    ...base,
    reconcileCustomer,
    reconcileAccount,
    holdAccess,
    releaseAccess,
    setJellyfinPassword,
    expireSubscriptionsAndReconcile,
    control
};
