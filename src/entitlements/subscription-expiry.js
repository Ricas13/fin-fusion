'use strict';

const { transaction } = require('../db');

async function expireDueSubscriptions() {
    return transaction(async client => {
        const rows = await client.query(`
            WITH expired AS (
                UPDATE subscriptions
                SET status='expired',service_extension_days=0,updated_at=NOW()
                WHERE superseded_by IS NULL
                  AND (
                    (status IN('active','trialing','past_due','paused','cancelled')
                     AND current_period_end+(COALESCE(service_extension_days,0)||' days')::interval<=NOW())
                    OR
                    (status='expired' AND COALESCE(service_extension_days,0)>0
                     AND current_period_end+(service_extension_days||' days')::interval<=NOW())
                  )
                RETURNING customer_id,plan_id,source
            )
            SELECT DISTINCT e.customer_id,BOOL_OR(p.price_minor>0) AS had_paid_expiry
            FROM expired e JOIN plans p ON p.id=e.plan_id
            GROUP BY e.customer_id
        `);
        return rows.rows;
    });
}

async function expireAndReconcile({ reconcileCustomer, autoDowngrade = null, onReconcileError = null } = {}) {
    if (typeof reconcileCustomer !== 'function') throw new Error('A subscription-expiry reconcile callback is required.');
    const expired = await expireDueSubscriptions();
    for (const row of expired) {
        const customerId = row.customer_id;
        let downgraded = null;
        if (row.had_paid_expiry && typeof autoDowngrade === 'function') downgraded = await autoDowngrade(customerId);
        if (downgraded) continue;
        try { await reconcileCustomer(customerId); }
        catch (error) {
            if (typeof onReconcileError === 'function') onReconcileError(customerId, error);
            else throw error;
        }
    }
    return expired.length;
}

module.exports = { expireDueSubscriptions, expireAndReconcile };
