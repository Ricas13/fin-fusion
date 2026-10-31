'use strict';

const { query, transaction } = require('../db');

const AREAS = new Set(['customers', 'orders', 'tickets', 'payments']);
const NAV_PREFIX = 'operator.business.';
const ACTIONABLE_PAYMENT_EVENT_SQL = `(processing_error IS NOT NULL OR processed_at IS NULL)
    AND NOT (
        provider='plisio'
        AND event_type IN (
            'operation.new',
            'operation.pending',
            'operation.pending internal',
            'operation.expired',
            'operation.cancelled',
            'operation.cancelled duplicate'
        )
    )`;

// JavaScript dates and the epoch numbers the browser used to send only hold milliseconds, while
// PostgreSQL timestamps hold microseconds. Watermarks therefore travel as lossless UTC text with
// microseconds, produced by the database itself, and go back into SQL as timestamptz untouched.
function exactSql(expression) {
    return `to_char((${expression}) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
}
const EXACT_WATERMARK = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// Is a row newer than the saved "seen" watermark? Compares the database's exact microsecond text
// when both sides have it (fixed-width UTC strings sort lexicographically), and falls back to
// millisecond dates for older cursors. Rows must therefore select exactSql(created_at) too, so a
// row created in the same millisecond as the watermark is not rounded away.
function isAfterWatermark(createdExact, createdAt, seen) {
    if (seen === undefined || seen === null || seen === '') return false;
    const seenText = seen instanceof Date ? '' : String(seen);
    if (createdExact && EXACT_WATERMARK.test(seenText)) return String(createdExact) > seenText;
    const since = new Date(seen).getTime();
    const created = new Date(createdAt).getTime();
    return Number.isFinite(since) && Number.isFinite(created) && created > since;
}

function area(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!AREAS.has(key)) throw new Error('Invalid operator read area.');
    return key;
}

function navKey(value) {
    return `${NAV_PREFIX}${area(value)}`;
}

function readWatermark(value) {
    if (value === undefined || value === null || value === '') throw new Error('Operator read watermark is required.');
    const numeric = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
    const parsed = numeric instanceof Date ? new Date(numeric.getTime()) : new Date(numeric);
    if (Number.isNaN(parsed.getTime())) throw new Error('Invalid operator read watermark.');
    return parsed;
}

async function list(adminUserId) {
    if (!adminUserId) return {};
    const keys = [...AREAS].map(key => `${NAV_PREFIX}${key}`);
    const result = await query(
        `SELECT nav_key,${exactSql('last_seen_at')} AS last_seen_at FROM admin_nav_read_state WHERE admin_user_id=$1 AND nav_key=ANY($2::text[])`,
        [adminUserId, keys]
    );
    return Object.fromEntries(result.rows.map(row => [row.nav_key.slice(NAV_PREFIX.length), row.last_seen_at]));
}

async function latestFor(client, key) {
    if (key === 'customers') {
        return (await client.query(`SELECT ${exactSql('COALESCE(MAX(created_at),NOW())')} seen_at FROM customers WHERE created_at>NOW()-INTERVAL '7 days'`)).rows[0].seen_at;
    }
    if (key === 'orders') {
        return (await client.query(`SELECT ${exactSql('COALESCE(MAX(created_at),NOW())')} seen_at FROM subscriptions WHERE created_at>NOW()-INTERVAL '7 days' AND source IN ('stripe','paypal') AND status IN ('active','trialing','past_due','paused')`)).rows[0].seen_at;
    }
    if (key === 'payments') {
        return (await client.query(`SELECT ${exactSql('COALESCE(MAX(created_at),NOW())')} seen_at FROM payment_events WHERE created_at>NOW()-INTERVAL '7 days' AND ${ACTIONABLE_PAYMENT_EVENT_SQL}`)).rows[0].seen_at;
    }
    return (await client.query(`SELECT ${exactSql('COALESCE(MAX(COALESCE(last_customer_reply_at,created_at)),NOW())')} seen_at FROM support_tickets WHERE status IN ('open','awaiting_staff')`)).rows[0].seen_at;
}

async function captureSeenThrough(value) {
    const key = area(value);
    return transaction(async client => latestFor(client, key));
}

async function markSeen(adminUserId, value, seenThrough) {
    if (!adminUserId) throw new Error('Administrator identity is required.');
    const key = area(value);
    const keyName = navKey(key);
    const seenAt = readWatermark(seenThrough);
    // An exact microsecond watermark (what the snapshot and the page captures now carry) is stored
    // untouched, so it covers the newest item shown and nothing created after it, even within the
    // same millisecond. A legacy millisecond value is rounded up by one millisecond so the newest
    // item still clears (at the cost of that one-millisecond window).
    const storedSeenAt = typeof seenThrough === 'string' && EXACT_WATERMARK.test(seenThrough) ? seenThrough : new Date(seenAt.getTime() + 1);
    return transaction(async client => {
        const result = await client.query(`
            INSERT INTO admin_nav_read_state(admin_user_id,nav_key,last_seen_at)
            VALUES($1,$2,$3)
            ON CONFLICT(admin_user_id,nav_key) DO UPDATE
            SET last_seen_at=GREATEST(admin_nav_read_state.last_seen_at,EXCLUDED.last_seen_at)
            RETURNING last_seen_at
        `, [adminUserId, keyName, storedSeenAt]);
        return { area:key, seen_at:result.rows[0].last_seen_at };
    });
}

module.exports = { AREAS, NAV_PREFIX, ACTIONABLE_PAYMENT_EVENT_SQL, EXACT_WATERMARK, exactSql, isAfterWatermark, area, navKey, readWatermark, list, markSeen, latestFor, captureSeenThrough };
