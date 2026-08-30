'use strict';

const { query, transaction } = require('../db');
const notificationDispatch = require('../integrations/notification-dispatch');
const expiryPolicy = require('../integrations/notification-expiry-policy');

const DEFAULT_WARNING_DAYS = Math.max(...expiryPolicy.DEFAULT_POLICY.milestones);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

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

function daysUntilExpiry(value, now = new Date()) {
    const end = new Date(value);
    const current = new Date(now);
    if (Number.isNaN(end.getTime()) || Number.isNaN(current.getTime()) || end <= current) return null;
    return Math.floor((end.getTime() - current.getTime()) / MS_PER_DAY);
}

function selectExpiryMilestone(value, milestones, now = new Date()) {
    const daysLeft = daysUntilExpiry(value, now);
    if (daysLeft == null) return null;
    const configured = expiryPolicy.normalizeMilestones(milestones, { fallback: [] });
    return configured.includes(daysLeft) ? daysLeft : null;
}

function expiryDedupeKey({ subscriptionId, accessExpiresAt, milestone }) {
    const end = new Date(accessExpiresAt);
    const periodEnd = Number.isNaN(end.getTime()) ? String(accessExpiresAt || 'unknown') : end.toISOString();
    return `subscription-expiring:${subscriptionId}:${periodEnd}:${milestone}`;
}

function providerExpiryProtected(row, syncResult) {
    if (!syncResult || syncResult.ok !== true) return true;
    const remote = syncResult.remote || {};
    if (remote.cancelAtPeriodEnd === true) return false;
    const source = String(row?.source || '').toLowerCase();
    const status = String(remote.status || '').toLowerCase();
    if (source === 'stripe') return ['active', 'trialing'].includes(status);
    if (source === 'paypal') return ['active', 'approval_pending', 'approved'].includes(status);
    return false;
}

async function dueRecurringSubscriptions() {
    const result = await query(`
        SELECT id,source,provider_subscription_id,status,cancel_at_period_end,current_period_end,service_extension_days
        FROM subscriptions
        WHERE superseded_by IS NULL
          AND source IN ('stripe','paypal')
          AND ((source='stripe' AND COALESCE(provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\')
            OR (source='paypal' AND COALESCE(provider_subscription_id,'') LIKE 'I-%'))
          AND (
            (status IN('active','trialing','past_due','paused','cancelled')
             AND current_period_end+(COALESCE(service_extension_days,0)||' days')::interval<=NOW())
            OR
            (status='expired' AND COALESCE(service_extension_days,0)>0
             AND current_period_end+(service_extension_days||' days')::interval<=NOW())
          )
        ORDER BY current_period_end,id
    `);
    return result.rows;
}

async function expiringSubscriptions({ days = DEFAULT_WARNING_DAYS } = {}) {
    const warningDays = Math.max(0, Math.min(30, Number(days) || 0));
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
          AND NOT EXISTS (
            SELECT 1
            FROM subscriptions next_s
            JOIN plans next_p ON next_p.id=next_s.plan_id
            WHERE next_s.customer_id=s.customer_id
              AND next_s.id<>s.id
              AND next_s.superseded_by IS NULL
              AND next_s.status IN('active','trialing','past_due','paused','cancelled')
              AND next_s.starts_at>s.starts_at
              AND next_s.starts_at<=s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval+INTERVAL '5 minutes'
              AND (
                COALESCE(next_s.service_type_snapshot,next_p.service_type,'jellyfin')='bundle'
                OR COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')='bundle'
                OR COALESCE(next_s.service_type_snapshot,next_p.service_type,'jellyfin')=COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')
              )
          )
          AND s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval>NOW()
          AND s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval<NOW()+(($1::int+1)*INTERVAL '1 day')
        ORDER BY access_expires_at,s.id
    `, [warningDays]);
    return result.rows.filter(row => !recurringAutoRenewal(row));
}

async function notifyExpiringSubscriptions({ days = null, milestones = null, dispatch = notificationDispatch.dispatch, now = new Date(), loadPolicy = expiryPolicy.load } = {}) {
    let reminderMilestones;
    if (milestones != null) reminderMilestones = expiryPolicy.normalizeMilestones(milestones, { fallback: [] });
    else if (days != null) reminderMilestones = expiryPolicy.normalizeMilestones([days], { fallback: [DEFAULT_WARNING_DAYS] });
    else reminderMilestones = expiryPolicy.normalizePolicy(await loadPolicy()).milestones;
    if (!reminderMilestones.length) return { candidates: 0, queued: 0, failed: 0 };

    const rows = await expiringSubscriptions({ days: Math.max(...reminderMilestones) });
    const result = { candidates: 0, queued: 0, failed: 0 };
    for (const row of rows) {
        const milestone = selectExpiryMilestone(row.access_expires_at, reminderMilestones, now);
        if (milestone == null) continue;
        result.candidates += 1;
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
                    autoRenewal: recurringAutoRenewal(row),
                    reminderDays: milestone
                },
                dedupeKey: expiryDedupeKey({ subscriptionId: row.id, accessExpiresAt: row.access_expires_at, milestone })
            });
            if (delivery && (delivery.email || delivery.telegram || delivery.discord || delivery.whatsapp)) result.queued += 1;
            if (Array.isArray(delivery?.errors) && delivery.errors.length) result.failed += 1;
        } catch (error) {
            result.failed += 1;
            console.warn('Subscription expiry warning failed:', { subscriptionId: row.id, customerId: row.customer_id, milestone, error: String(error?.message || error).slice(0, 300) });
        }
    }
    return result;
}

async function expireDueSubscriptions({ syncRecurring = null } = {}) {
    const dueRecurring = await dueRecurringSubscriptions();
    const protectedIds = [];
    for (const row of dueRecurring) {
        if (typeof syncRecurring !== 'function') {
            protectedIds.push(row.id);
            continue;
        }
        try {
            const syncResult = await syncRecurring(row.id);
            if (providerExpiryProtected(row, syncResult)) protectedIds.push(row.id);
        } catch (error) {
            protectedIds.push(row.id);
            console.warn('Recurring subscription expiry verification failed closed:', { subscriptionId: row.id, provider: row.source, error: String(error?.message || error).slice(0, 300) });
        }
    }

    return transaction(async client => {
        const rows = await client.query(`
            WITH expired AS (
                UPDATE subscriptions s
                SET status='expired',service_extension_days=0,updated_at=NOW()
                WHERE s.superseded_by IS NULL
                  AND NOT (s.id=ANY($1::uuid[]))
                  AND (
                    (s.status IN('active','trialing','past_due','paused','cancelled')
                     AND s.current_period_end+(COALESCE(s.service_extension_days,0)||' days')::interval<=NOW())
                    OR
                    (s.status='expired' AND COALESCE(s.service_extension_days,0)>0
                     AND s.current_period_end+(s.service_extension_days||' days')::interval<=NOW())
                  )
                RETURNING s.customer_id,s.plan_id,s.source
            )
            SELECT DISTINCT e.customer_id,BOOL_OR(p.price_minor>0) AS had_paid_expiry
            FROM expired e JOIN plans p ON p.id=e.plan_id
            GROUP BY e.customer_id
        `, [protectedIds]);
        return rows.rows;
    });
}

async function expireAndReconcile({ reconcileCustomer, autoDowngrade = null, onReconcileError = null, syncRecurring = null } = {}) {
    if (typeof reconcileCustomer !== 'function') throw new Error('A subscription-expiry reconcile callback is required.');
    const expired = await expireDueSubscriptions({ syncRecurring });
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

module.exports = { DEFAULT_WARNING_DAYS, recurringAutoRenewal, expiryDate, daysUntilExpiry, selectExpiryMilestone, expiryDedupeKey, providerExpiryProtected, dueRecurringSubscriptions, expiringSubscriptions, notifyExpiringSubscriptions, expireDueSubscriptions, expireAndReconcile };
