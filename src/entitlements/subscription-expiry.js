'use strict';

const { query, transaction } = require('../db');
const notificationDispatch = require('../integrations/notification-dispatch');
const expiryPolicy = require('../integrations/notification-expiry-policy');
const billingMode = require('../payments/subscription-billing-mode');
const automaticFreeDowngradeRetry = require('./automatic-free-downgrade-retry');

const DEFAULT_WARNING_DAYS = Math.max(...expiryPolicy.DEFAULT_POLICY.milestones);
const DEFAULT_PROVIDER_VERIFICATION_GRACE_HOURS = 48;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MS_PER_HOUR = 60 * 60 * 1000;

function recurringAutoRenewal(row) {
    const status = String(row?.status || '').toLowerCase();
    if (!['active', 'trialing'].includes(status) || row?.cancel_at_period_end === true) return false;
    return billingMode.isRecurring(row);
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

function providerVerificationGraceHours(value = process.env.RECURRING_EXPIRY_VERIFICATION_GRACE_HOURS) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return DEFAULT_PROVIDER_VERIFICATION_GRACE_HOURS;
    return Math.max(1, Math.min(168, Math.round(parsed)));
}

function localAccessEnd(row) {
    const periodEnd = new Date(row?.current_period_end);
    if (Number.isNaN(periodEnd.getTime())) return null;
    const extensionDays = Math.max(0, Number(row?.service_extension_days || 0));
    return new Date(periodEnd.getTime() + extensionDays * MS_PER_DAY);
}

function failedProviderVerificationProtected(row, { now = new Date(), graceHours = providerVerificationGraceHours() } = {}) {
    const end = localAccessEnd(row);
    const current = new Date(now);
    if (!end || Number.isNaN(current.getTime())) return false;
    return current.getTime() < end.getTime() + Math.max(1, Number(graceHours) || DEFAULT_PROVIDER_VERIFICATION_GRACE_HOURS) * MS_PER_HOUR;
}

function providerExpiryProtected(row, syncResult, options = {}) {
    // Provider outages are allowed a bounded grace period so a brief Stripe or
    // PayPal incident does not switch off customers whose renewal may really
    // have succeeded. The old behavior protected a due row forever whenever
    // provider verification kept failing, which could turn a missed webhook +
    // provider outage into indefinite unpaid access.
    if (!syncResult || syncResult.ok !== true) return failedProviderVerificationProtected(row, options);
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
        SELECT id,source,billing_mode,provider_subscription_id,status,cancel_at_period_end,current_period_end,service_extension_days
        FROM subscriptions
        WHERE superseded_by IS NULL
          AND source IN ('stripe','paypal')
          AND billing_mode='subscription'
          AND status IN('active','trialing','past_due','paused')
          AND current_period_end+(COALESCE(service_extension_days,0)||' days')::interval<=NOW()
        ORDER BY current_period_end,id
    `);
    return result.rows;
}

async function expiringSubscriptions({ days = DEFAULT_WARNING_DAYS } = {}) {
    const warningDays = Math.max(0, Math.min(30, Number(days) || 0));
    const result = await query(`
        SELECT s.id,s.customer_id,s.status,s.source,s.billing_mode,s.provider_subscription_id,s.cancel_at_period_end,
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
          AND NOT public.subscription_admin_present(s.customer_id,COALESCE(s.service_type_snapshot,p.service_type,'jellyfin'),s.id)
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
        const planName = String(row.plan_name || 'Your subscription').trim() || 'Your subscription';
        result.candidates += 1;
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

function expiryVerificationEventId(row) {
    const end = localAccessEnd(row);
    const marker = end ? end.toISOString() : String(row?.current_period_end || 'unknown').slice(0, 80);
    return `expiry-verification:${row.id}:${marker}`;
}

async function recordExpiryVerificationFailure(row, error, { incidentRecorder = null, graceHours = providerVerificationGraceHours() } = {}) {
    if (!row?.provider_subscription_id || !['stripe', 'paypal'].includes(String(row.source || '').toLowerCase())) return null;
    const record = incidentRecorder || require('../payments/incidents').record;
    const end = localAccessEnd(row);
    return record({
        provider: String(row.source).toLowerCase(),
        eventId: expiryVerificationEventId(row),
        kind: 'failed_renewal',
        status: 'open',
        providerSubscriptionId: row.provider_subscription_id,
        metadata: {
            reason: 'expiry_provider_verification_exhausted',
            localAccessEndedAt: end ? end.toISOString() : null,
            verificationGraceHours: Number(graceHours),
            verificationError: String(error?.message || error || 'Provider verification unavailable').replace(/\s+/g, ' ').trim().slice(0, 500)
        }
    });
}

async function expireDueSubscriptions({ syncRecurring = null, now = new Date(), graceHours = providerVerificationGraceHours(), incidentRecorder = null } = {}) {
    const dueRecurring = await dueRecurringSubscriptions();
    const protectedIds = [];
    for (const row of dueRecurring) {
        let syncResult = null;
        let verificationError = null;
        if (typeof syncRecurring !== 'function') {
            verificationError = new Error('Recurring provider verification callback is unavailable.');
        } else {
            try {
                syncResult = await syncRecurring(row.id);
                if (!syncResult || syncResult.ok !== true) verificationError = new Error(syncResult?.error || 'Provider verification did not complete successfully.');
            } catch (error) {
                verificationError = error;
            }
        }

        if (providerExpiryProtected(row, syncResult, { now, graceHours })) {
            protectedIds.push(row.id);
            if (verificationError) {
                console.warn('Recurring subscription expiry verification failed closed within bounded grace:', { subscriptionId: row.id, provider: row.source, graceHours, error: String(verificationError?.message || verificationError).slice(0, 300) });
            }
            continue;
        }

        if (verificationError) {
            // Once the bounded safety grace has elapsed, local contract truth is
            // allowed to expire rather than granting access indefinitely. Record
            // a durable operator-visible incident first so a provider outage or
            // missed webhook cannot become a silent commercial-state decision.
            try {
                await recordExpiryVerificationFailure(row, verificationError, { incidentRecorder, graceHours });
            } catch (incidentError) {
                // If we cannot durably surface the commercial ambiguity, fail
                // this run rather than expiring access silently.
                throw new Error(`Could not record exhausted ${row.source} expiry verification for subscription ${row.id}: ${incidentError.message}`);
            }
            console.warn('Recurring subscription expiry verification grace exhausted; local term will expire:', { subscriptionId: row.id, provider: row.source, graceHours, error: String(verificationError?.message || verificationError).slice(0, 300) });
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

async function expireAndReconcile({ reconcileCustomer, autoDowngrade = null, onAutoDowngradeError = null, onReconcileError = null, syncRecurring = null, detail = false } = {}) {
    if (typeof reconcileCustomer !== 'function') throw new Error('A subscription-expiry reconcile callback is required.');
    const verifyRecurring = typeof syncRecurring === 'function'
        ? syncRecurring
        : subscriptionId => require('../payments/billing-control').syncSubscription(subscriptionId);
    const expired = await expireDueSubscriptions({ syncRecurring: verifyRecurring });
    let failed = 0;
    for (const row of expired) {
        const customerId = row.customer_id;
        let downgraded = null;
        if (row.had_paid_expiry && typeof autoDowngrade === 'function') {
            try {
                downgraded = await autoDowngrade(customerId, row);
            } catch (error) {
                // The commercial expiry is already committed at this point. A
                // failed configured Free fallback must therefore become a
                // durable lifecycle retry before normal reconciliation closes
                // the expired paid access. If this write fails, fail the job
                // rather than pretending a future retry is guaranteed.
                await automaticFreeDowngradeRetry.enqueue(customerId, error);
                failed += 1;
                if (typeof onAutoDowngradeError === 'function') onAutoDowngradeError(customerId, error);
            }
        }
        if (downgraded) continue;
        try { await reconcileCustomer(customerId); }
        catch (error) {
            failed += 1;
            if (typeof onReconcileError === 'function') onReconcileError(customerId, error);
            else throw error;
        }
    }
    return detail ? { expired: expired.length, failed } : expired.length;
}

module.exports = {
    DEFAULT_WARNING_DAYS,
    DEFAULT_PROVIDER_VERIFICATION_GRACE_HOURS,
    recurringAutoRenewal,
    expiryDate,
    daysUntilExpiry,
    selectExpiryMilestone,
    expiryDedupeKey,
    providerVerificationGraceHours,
    localAccessEnd,
    failedProviderVerificationProtected,
    providerExpiryProtected,
    expiryVerificationEventId,
    recordExpiryVerificationFailure,
    dueRecurringSubscriptions,
    expiringSubscriptions,
    notifyExpiringSubscriptions,
    expireDueSubscriptions,
    expireAndReconcile
};
