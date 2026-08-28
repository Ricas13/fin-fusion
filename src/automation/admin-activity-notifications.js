'use strict';

const { query } = require('../db');
const notifications = require('../integrations/notification-dispatch');

const STATE_KEY = 'admin_activity_notification_cursor_v1';
const INITIAL_LOOKBACK_MS = 15 * 60 * 1000;
const MAX_CATCHUP_MS = 7 * 24 * 60 * 60 * 1000;

function validDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
}

function clean(value, max = 500) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim().slice(0, max);
}

function money(minor, currency) {
    const amount = Number(minor);
    const code = String(currency || '').trim().toUpperCase();
    if (!Number.isFinite(amount) || !code) return '';
    return `${code} ${(amount / 100).toFixed(2)}`;
}

async function loadCursor(now = new Date()) {
    const result = await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [STATE_KEY]);
    const stored = validDate(result.rows[0]?.setting_value?.cursor);
    const oldest = new Date(now.getTime() - MAX_CATCHUP_MS);
    const fallback = new Date(now.getTime() - INITIAL_LOOKBACK_MS);
    if (!stored || stored > now) return fallback;
    return stored < oldest ? oldest : stored;
}

async function saveCursor(cursor) {
    await query(`
        INSERT INTO platform_settings(setting_key,setting_value)
        VALUES($1,$2::jsonb)
        ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
    `, [STATE_KEY, JSON.stringify({ cursor: cursor.toISOString() })]);
}

async function emit(summary, input) {
    summary.processed += 1;
    try {
        const delivery = await notifications.dispatch(input);
        if (delivery && (delivery.email || delivery.telegram || delivery.discord || delivery.whatsapp)) summary.queued += 1;
        if (Array.isArray(delivery?.errors) && delivery.errors.length) summary.failed += 1;
        return delivery;
    } catch (error) {
        summary.failed += 1;
        console.warn('Admin activity notification dispatch failed:', { eventType: input.eventType, error: clean(error?.message || error, 300) });
        return null;
    }
}

async function claimEvents(since, until, summary) {
    const result = await query(`
        SELECT a.id,a.entity_id customer_id,a.metadata,a.created_at,
               COALESCE(c.display_name,u.username,c.email,'Customer') customer_name
        FROM audit_log a
        JOIN customers c ON c.id::text=a.entity_id
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE a.action='customer.claim.complete' AND a.created_at>$1 AND a.created_at<=$2
        ORDER BY a.created_at,a.id
    `, [since, until]);
    for (const row of result.rows) {
        const name = clean(row.customer_name, 160) || row.customer_id;
        const username = clean(row.metadata?.username, 80);
        await emit(summary, {
            eventType: 'customer.claimed',
            customerId: row.customer_id,
            subject: 'Imported account claimed',
            text: `${name} claimed an imported Jellyfin account${username ? ` using portal username ${username}` : ''}. Existing Jellyfin credentials were left unchanged.`,
            dedupeKey: `customer-claimed:${row.id}`
        });
    }
}

async function discountEvents(since, until, summary) {
    const result = await query(`
        SELECT dr.id,dr.customer_id,dr.amount_applied_minor,dr.created_at,dc.code,
               COALESCE(c.display_name,u.username,c.email,'Customer') customer_name,
               COALESCE(s.currency_snapshot,p.currency,'') currency,
               COALESCE(s.plan_name_snapshot,p.name,'Subscription') plan_name
        FROM discount_redemptions dr
        JOIN discount_codes dc ON dc.id=dr.discount_code_id
        LEFT JOIN customers c ON c.id=dr.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        LEFT JOIN subscriptions s ON s.id=dr.subscription_id
        LEFT JOIN plans p ON p.id=s.plan_id
        WHERE dr.created_at>$1 AND dr.created_at<=$2
        ORDER BY dr.created_at,dr.id
    `, [since, until]);
    for (const row of result.rows) {
        const name = clean(row.customer_name, 160) || row.customer_id || 'Customer';
        const amount = money(row.amount_applied_minor, row.currency);
        const plan = clean(row.plan_name, 160) || 'subscription';
        await emit(summary, {
            eventType: 'commercial.discount.redeemed',
            customerId: row.customer_id,
            subject: `Discount redeemed: ${clean(row.code, 80)}`,
            text: `${name} redeemed ${clean(row.code, 80)} on ${plan}${amount ? `, saving ${amount}` : ''}.`,
            dedupeKey: `discount-redeemed:${row.id}`
        });
    }
}

async function accessHoldEvents(since, until, summary) {
    const result = await query(`
        SELECT h.id,h.customer_id,h.hold_type,h.source_key,h.reason,h.metadata,h.created_at,
               COALESCE(c.display_name,u.username,c.email,'Customer') customer_name
        FROM customer_access_holds h
        JOIN customers c ON c.id=h.customer_id
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE h.created_at>$1 AND h.created_at<=$2
        ORDER BY h.created_at,h.id
    `, [since, until]);
    for (const row of result.rows) {
        const name = clean(row.customer_name, 160) || row.customer_id;
        const type = clean(row.hold_type, 80) || 'access hold';
        const reason = clean(row.reason, 300) || clean(row.source_key, 180) || type;
        const provider = clean(row.metadata?.provider, 40);
        const status = clean(row.metadata?.status, 80);
        const extra = [provider, status].filter(Boolean).join(' / ');
        await emit(summary, {
            eventType: 'customer.access.suspended',
            customerId: row.customer_id,
            subject: `Access suspended: ${name}`,
            text: `${name} received a ${type} hold — ${reason}.${extra ? ` Provider state: ${extra}.` : ''}`,
            dedupeKey: `customer-access-suspended:${row.id}`
        });
    }
}

async function loginEvents(since, until, summary) {
    const result = await query(`
        SELECT a.id,a.actor_user_id,a.entity_id customer_id,a.metadata,a.created_at,
               COALESCE(c.display_name,u.username,c.email,'Customer') customer_name
        FROM audit_log a
        JOIN customers c ON c.id::text=a.entity_id
        LEFT JOIN app_users u ON u.id=c.user_id
        WHERE a.action='customer.login.success' AND a.created_at>$1 AND a.created_at<=$2
        ORDER BY a.created_at,a.id
    `, [since, until]);
    for (const row of result.rows) {
        const name = clean(row.customer_name, 160) || row.customer_id;
        await emit(summary, {
            eventType: 'login.customer.succeeded',
            customerId: row.customer_id,
            subject: `Customer signed in: ${name}`,
            text: `${name} signed in to the customer portal${row.metadata?.twoFactorUsed ? ' with two-factor authentication' : ''}.`,
            dedupeKey: `customer-login:${row.id}`
        });
    }
}

async function run() {
    const until = new Date();
    const since = await loadCursor(until);
    const summary = { processed: 0, queued: 0, failed: 0, windowStart: since.toISOString(), windowEnd: until.toISOString() };
    await claimEvents(since, until, summary);
    await discountEvents(since, until, summary);
    await accessHoldEvents(since, until, summary);
    await loginEvents(since, until, summary);
    await saveCursor(until);
    return summary;
}

module.exports = { STATE_KEY, INITIAL_LOOKBACK_MS, MAX_CATCHUP_MS, validDate, clean, money, loadCursor, run };
