'use strict';

const { query, transaction } = require('../db');
const notificationDispatch = require('../integrations/notification-dispatch');
const expiryPolicy = require('../integrations/notification-expiry-policy');

const DEFAULT_WARNING_DAYS = Math.max(...expiryPolicy.DEFAULT_POLICY.milestones);
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function recurringProviderSubscription(row) {
    const source = String(row?.source || '').toLowerCase();
    const providerId = String(row?.provider_subscription_id || '');
    return (source === 'stripe' && providerId.startsWith('sub_')) ||
        (source === 'paypal' && providerId.startsWith('I-'));
}

function recurringAutoRenewal(row) {
    if (String(row?.status || '').toLowerCase() !== 'active') return false;
    if (row?.cancel_at_period_end === true) return false;
    return recurringProviderSubscription(row);
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

async function expiringSubscriptions({ days = DEFAULT_WARNING_DAYS } = {}) {
    const warningDays = Math.max(0, Math.min(30, Number(days) || 0));
    const result = await query(`
        SELECT s.id,s.customer_id,s.status,s.source,s.provider_subscription_id,s.cancel_at_period_end,
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
              AND next_s.status IN('active','trialing','past_due','paused')
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

async function dueRecurringExpiryCandidates() {
    const result = await query(`
        SELECT id,customer_id,source,provider_subscription_id,status,current_period_end,service_extension_days
        FROM subscriptions
        WHERE superseded_by IS NULL
          AND status IN('active','trialing','past_due','paused','cancelled')
          AND current_period_end IS NOT NULL
          AND current_period_end+(COALESCE(service_extension_days,0)||' days')::interval<=NOW()
          AND (
            (source='stripe' AND provider_subscription_id LIKE 'sub\\_%' ESCAPE '\\')
            OR (source='paypal' AND provider_subscription_id LIKE 'I-%')
          )
        ORDER BY current_period_end,id
    `);
    return result.rows;
}

async function refreshDueRecurringSubscriptions({ syncRecurringSubscription = null, onProviderSyncError = null } = {}) {
    const candidates = await dueRecurringExpiryCandidates();
    const verifiedIds = [];
    let failed = 0;
    for (const row of candidates) {
        if (typeof syncRecurringSubscription !== 'function') {
            failed += 1;
            if (typeof onProviderSyncError === 'function') onProviderSyncError(row, new Error('No recurring provider-sync owner was supplied.'));
            continue;
        }
        try {
            const result = await syncRecurringSubscription(row.id);
            if (result?.ok === true) verifiedIds.push(String(row.id));
            else {
                failed += 1;
                if (typeof onProviderSyncError === 'function') onProviderSyncError(row, new Error(result?.error || 'Recurring provider state could not be verified.'));
            }
        } catch (error) {
            failed += 1;
            if (typeof onProviderSyncError === 'function') onProviderSyncError(row, error);
        }
    }
    return { candidates: candidates.length, verifiedIds, failed };
}

async function expireDueSubscriptions({ verifiedRecurringIds = [] } = {}) {
    const verified = [...new Set((Array.isArray(verifiedRecurringIds) ? verifiedRecurringIds : []).map(String).filter(Boolean))];
    return transaction(async client => {
        const rows = await client.query(`
            WITH expired AS (
                UPDATE subscriptions
                SET status='expired',service_extension_days=0,updated_at=NOW()
                WHERE superseded_by IS NULL
                  AND (
                    (
                      status IN('active','trialing','past_due','paused','cancelled')
                      AND current_period_end+(COALESCE(service_extension_days,0)||' days')::interval<=NOW()
                      AND (
                        NOT (
                          (source='stripe' AND provider_subscription_id LIKE 'sub\\_%' ESCAPE '\\')
                          OR (source='paypal' AND provider_subscription_id LIKE 'I-%')
                        )
                        OR id::text=ANY($1::text[])
                      )
                    )
                    OR
                    (status='expired' AND COALESCE(service_extension_days,0)>0
                     AND current_period_end+(service_extension_days||' days')::interval<=NOW())
                  )
                RETURNING customer_id,plan_id,source,service_type_snapshot
            )
            SELECT DISTINCT e.customer_id,
                   BOOL_OR(p.price_minor>0) AS had_paid_expiry,
                   BOOL_OR(
                     p.price_minor>0
                     AND COALESCE(NULLIF(e.service_type_snapshot,''),p.service_type,'jellyfin') IN ('jellyfin','bundle')
                   ) AS had_paid_jellyfin_expiry
            FROM expired e JOIN plans p ON p.id=e.plan_id
            GROUP BY e.customer_id
        `, [verified]);
        return rows.rows;
    });
}

async function expireAndReconcile({ reconcileCustomer, autoDowngrade = null, onReconcileError = null, syncRecurringSubscription = null, onProviderSyncError = null } = {}) {
    if (typeof reconcileCustomer !== 'function') throw new Error('A subscription-expiry reconcile callback is required.');
    const refresh = await refreshDueRecurringSubscriptions({ syncRecurringSubscription, onProviderSyncError });
    const expired = await expireDueSubscriptions({ verifiedRecurringIds: refresh.verifiedIds });
    for (const row of expired) {
        const customerId = row.customer_id;
        let downgraded = null;
        if (row.had_paid_jellyfin_expiry && typeof autoDowngrade === 'function') downgraded = await autoDowngrade(customerId);
        if (downgraded) continue;
        try { await reconcileCustomer(customerId); }
        catch (error) {
            if (typeof onReconcileError === 'function') onReconcileError(customerId, error);
            else throw error;
        }
    }
    return expired.length;
}

module.exports = { DEFAULT_WARNING_DAYS, recurringProviderSubscription, recurringAutoRenewal, expiryDate, daysUntilExpiry, selectExpiryMilestone, expiryDedupeKey, expiringSubscriptions, notifyExpiringSubscriptions, dueRecurringExpiryCandidates, refreshDueRecurringSubscriptions, expireDueSubscriptions, expireAndReconcile };
