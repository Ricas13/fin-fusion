'use strict';

const { query } = require('../db');
const emailOutbox = require('../integrations/email-outbox');
const { renderProfessionalEmail } = require('../integrations/email-template');
const runtimeSettings = require('../platform/runtime-settings');
const operationsSettings = require('../platform/operations-settings');

const STATE_KEY = 'service_end_email_cursor_v1';
const INITIAL_LOOKBACK_MS = 15 * 60 * 1000;
const MAX_CATCHUP_MS = 7 * 24 * 60 * 60 * 1000;

function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
}

function periodKey(value) {
    const date = validDate(value);
    return date ? date.toISOString() : 'unknown';
}

function clean(value, max = 300) {
    return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

async function loadState(now = new Date()) {
    const result = await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [STATE_KEY]);
    const stored = validDate(result.rows[0]?.setting_value?.cursor);
    const oldest = new Date(now.getTime() - MAX_CATCHUP_MS);
    const fallback = new Date(now.getTime() - INITIAL_LOOKBACK_MS);
    return stored && stored <= now ? (stored < oldest ? oldest : stored) : fallback;
}

async function saveState(cursor) {
    await query(`
        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES($1,$2::jsonb)
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
    `, [STATE_KEY, JSON.stringify({ cursor: cursor.toISOString() })]);
}

async function expiredSubscriptions(since, until) {
    const result = await query(`
        SELECT s.id,s.customer_id,s.current_period_end,s.updated_at,
               COALESCE(s.plan_name_snapshot,p.name,'Your plan') AS plan_name,
               COALESCE(s.billing_interval_snapshot,p.billing_interval)='trial' AS is_trial,
               COALESCE(NULLIF(TRIM(c.email),''),NULLIF(TRIM(au.email),'')) AS customer_email,
               COALESCE(NULLIF(c.display_name,''),NULLIF(au.username,''),'there') AS customer_name
        FROM subscriptions s
        JOIN plans p ON p.id=s.plan_id
        JOIN customers c ON c.id=s.customer_id
        LEFT JOIN app_users au ON au.id=c.user_id
        WHERE s.status='expired'
          AND s.updated_at>$1 AND s.updated_at<=$2
          AND COALESCE(p.is_free_tier,FALSE)=FALSE
          AND s.superseded_by IS NULL
          AND NOT EXISTS (
              SELECT 1
              FROM subscriptions newer
              JOIN plans newer_plan ON newer_plan.id=newer.plan_id
              WHERE newer.customer_id=s.customer_id
                AND newer.id<>s.id
                AND newer.superseded_by IS NULL
                AND newer.starts_at>s.starts_at
                AND newer.starts_at<=NOW()
                AND newer.status IN('active','trialing','past_due','paused')
                AND newer.current_period_end>NOW()
                AND (
                    COALESCE(newer.service_type_snapshot,newer_plan.service_type,'jellyfin')='bundle'
                    OR COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')='bundle'
                    OR COALESCE(newer.service_type_snapshot,newer_plan.service_type,'jellyfin')=COALESCE(s.service_type_snapshot,p.service_type,'jellyfin')
                )
          )
        ORDER BY s.updated_at,s.id
    `, [since, until]);
    return result.rows;
}

function messageFor(row, siteName, storeUrl) {
    const planName = clean(row.plan_name, 180) || 'Your plan';
    if (row.is_trial) {
        const subject = 'Your trial has come to an end';
        const text = `Your trial has come to an end. We hope you enjoyed your time with ${siteName}. If you'd like to keep your access, you can choose a plan from our store whenever you're ready.`;
        return {
            type: 'customer.trial.ended',
            subject,
            text,
            html: renderProfessionalEmail({
                eventType: 'customer.trial.ended',
                eventLabel: 'Trial ended',
                subject,
                title: subject,
                text,
                actionLabel: storeUrl ? 'Subscribe now' : '',
                actionUrl: storeUrl,
                payload: { planName, expiresOn: row.current_period_end },
                nextStep: 'Choose a plan from the store to continue your access.',
                siteName,
                publicBaseUrl: storeUrl,
                transactional: true
            }),
            dedupeKey: `service-end-email:trial:${row.id}:${periodKey(row.current_period_end)}`
        };
    }

    const subject = 'Your subscription has ended';
    const text = `Your subscription has now ended. We're sad to see you go, but you're always welcome back. If you'd like to return, you can subscribe again at any time from our store.`;
    return {
        type: 'customer.subscription.ended',
        subject,
        text,
        html: renderProfessionalEmail({
            eventType: 'customer.subscription.ended',
            eventLabel: 'Subscription ended',
            subject,
            title: subject,
            text,
            actionLabel: storeUrl ? 'Subscribe again' : '',
            actionUrl: storeUrl,
            payload: { planName, expiresOn: row.current_period_end },
            nextStep: 'Visit the store whenever you would like to come back.',
            siteName,
            publicBaseUrl: storeUrl,
            transactional: true
        }),
        dedupeKey: `service-end-email:subscription:${row.id}:${periodKey(row.current_period_end)}`
    };
}

async function run({ now = new Date() } = {}) {
    const until = validDate(now) || new Date();
    const since = await loadState(until);
    const rows = await expiredSubscriptions(since, until);
    const result = { processed: rows.length, queued: 0, skipped: 0, failed: 0, cursorRetained: false };

    await runtimeSettings.ensureLoaded().catch(() => null);
    const siteName = runtimeSettings.siteName();
    const operations = await operationsSettings.get().catch(() => operationsSettings.DEFAULTS);
    const storeUrl = clean(operations.publicBaseUrl, 1000).replace(/\/+$/, '');

    for (const row of rows) {
        const to = clean(row.customer_email, 254).toLowerCase();
        if (!to) {
            result.skipped += 1;
            continue;
        }
        try {
            const email = messageFor(row, siteName, storeUrl);
            await emailOutbox.enqueue({ ...email, to });
            result.queued += 1;
        } catch (error) {
            result.failed += 1;
            console.warn('Service-end email enqueue failed:', {
                subscriptionId: row.id,
                customerId: row.customer_id,
                error: clean(error?.message || error, 500)
            });
        }
    }

    if (result.failed === 0) await saveState(until);
    else result.cursorRetained = true;
    return result;
}

module.exports = { STATE_KEY, INITIAL_LOOKBACK_MS, MAX_CATCHUP_MS, loadState, saveState, expiredSubscriptions, messageFor, run };
