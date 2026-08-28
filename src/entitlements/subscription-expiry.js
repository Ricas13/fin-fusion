'use strict';

const { query, transaction } = require('../db');
const notificationDispatch = require('../integrations/notification-dispatch');

const DEFAULT_WARNING_DAYS = Math.max(1, Math.min(30, Number(process.env.SUBSCRIPTION_EXPIRY_WARNING_DAYS || 7)));

function recurringAutoRenewal(row) {
    if (String(row?.status || '').toLowerCase() !== 'active') return false;
    const source = String(row?.source || '').toLowerCase();
    const providerId = String(row?.provider_subscription_id || '');
    return (source === 'stripe' && providerId.startsWith('sub_')) ||
        (source === 'paypal' && providerId.startsWith('I-'));
}

function expiryDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return 'soon';
    return date.toLocaleDateString('en-GB', { dateStyle: 'long', timeZone: 'UTC' });
}

async function expiringSubscriptions({ days = DEFAULT_WARNING_DAYS } = {}) {
    const warningDays = Math.max(1, Math.min(30, Number(days) || DEFAULT_WARNING_DAYS));
    const result = await query(`
        SELECT s.id,s.customer_id,s.status,s.source,s.provider_subscription_id,
               COALESCE(s.plan_name_snapshot,p.name,'Your subscription') AS plan_name,
               s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval AS access_expires_at,
               COALESCE(c.display_name,au.username,c.email,'Customer') AS customer_name
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users au ON au.id=c.user_id
        WHERE s.superseded_by IS NULL
          AND s.status IN('active','trialing','past_due','paused','cancelled')
          AND s.current_period_end IS NOT NULL
          AND COALESCE(p.is_free_tier,FALSE)=FALSE
          AND NOT EXISTS (
            SELECT 1 FROM customer_entitlement_overrides o
            WHERE o.customer_id=s.customer_id AND o.subscription_id=s.id
              AND o.permanent_access=TRUE AND o.revoked_at IS NULL
          )
          AND s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval>NOW()
          AND s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval<=NOW()+($1::int*INTERVAL '1 day')
        ORDER BY access_expires_at,s.id
    `, [warningDays]);
    return result.rows.filter(row => !recurringAutoRenewal(row));
}

async function notifyExpiringSubscriptions({ days = DEFAULT_WARNING_DAYS, dispatch = notificationDispatch.dispatch } = {}) {
    const rows = await expiringSubscriptions({ days });
    const result = { candidates: rows.length, queued: 0, failed: 0 };
    for (const row of rows) {
        const end = new Date(row.access_expires_at);
        const endKey = Number.isNaN(end.getTime()) ? String(row.access_expires_at || 'unknown') : end.toISOString();
        const planName = String(row.plan_name || 'Your subscription').trim() || 'Your subscription';
        try {
            const delivery = await dispatch({
                eventType: 'subscription.expiring',
                customerId: row.customer_id,
                subject: `${planName} expires soon`,
                text: `Your ${planName} access is due to expire on ${expiryDate(row.access_expires_at)}. Renew or choose a plan before then to avoid interruption.`,
                adminText: `${String(row.customer_name || 'Customer').trim()}'s ${planName} access is due to expire on ${expiryDate(row.access_expires_at)}.`,
                templatePayload: {
                    customerName: String(row.customer_name || 'Customer').trim(),
                    planName,
                    expiresOn: row.access_expires_at,
                    provider: row.source,
                    autoRenewal: recurringAutoRenewal(row)
                },
                dedupeKey: `subscription-expiring:${row.id}:${endKey}`
            });
            if (delivery && (delivery.email || delivery.telegram || delivery.discord || delivery.whatsapp)) result.queued += 1;
            if (Array.isArray(delivery?.errors) && delivery.errors.length) result.failed += 1;
        } catch (error) {
            result.failed += 1;
            console.warn('Subscription expiry warning failed:', { subscriptionId: row.id, customerId: row.customer_id, error: String(error?.message || error).slice(0, 300) });
        }
    }
    return result;
}

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

module.exports = { DEFAULT_WARNING_DAYS, recurringAutoRenewal, expiryDate, expiringSubscriptions, notifyExpiringSubscriptions, expireDueSubscriptions, expireAndReconcile };
