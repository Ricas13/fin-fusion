'use strict';

const { query, transaction } = require('../db');

const AREAS = new Set(['customers', 'orders', 'tickets', 'payments']);
const NAV_PREFIX = 'operator.business.';

function area(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!AREAS.has(key)) throw new Error('Invalid operator read area.');
    return key;
}

function navKey(value) {
    return `${NAV_PREFIX}${area(value)}`;
}

async function list(adminUserId) {
    if (!adminUserId) return {};
    const keys = [...AREAS].map(key => `${NAV_PREFIX}${key}`);
    const result = await query(
        `SELECT nav_key,last_seen_at FROM admin_nav_read_state WHERE admin_user_id=$1 AND nav_key=ANY($2::text[])`,
        [adminUserId, keys]
    );
    return Object.fromEntries(result.rows.map(row => [row.nav_key.slice(NAV_PREFIX.length), row.last_seen_at]));
}

async function latestFor(client, key) {
    if (key === 'customers') {
        return (await client.query(`SELECT COALESCE(MAX(created_at),NOW()) seen_at FROM customers WHERE created_at>NOW()-INTERVAL '7 days'`)).rows[0].seen_at;
    }
    if (key === 'orders') {
        return (await client.query(`SELECT COALESCE(MAX(created_at),NOW()) seen_at FROM subscriptions WHERE created_at>NOW()-INTERVAL '7 days' AND source IN ('stripe','paypal') AND status IN ('active','trialing','past_due','paused')`)).rows[0].seen_at;
    }
    if (key === 'payments') {
        return (await client.query(`SELECT COALESCE(MAX(created_at),NOW()) seen_at FROM payment_events WHERE created_at>NOW()-INTERVAL '7 days' AND (processing_error IS NOT NULL OR processed_at IS NULL)`)).rows[0].seen_at;
    }
    return (await client.query(`SELECT COALESCE(MAX(COALESCE(last_customer_reply_at,created_at)),NOW()) seen_at FROM support_tickets WHERE status IN ('open','awaiting_staff')`)).rows[0].seen_at;
}

async function markSeen(adminUserId, value) {
    if (!adminUserId) throw new Error('Administrator identity is required.');
    const key = area(value);
    const keyName = navKey(key);
    return transaction(async client => {
        const seenAt = await latestFor(client, key);
        const result = await client.query(`
            INSERT INTO admin_nav_read_state(admin_user_id,nav_key,last_seen_at)
            VALUES($1,$2,$3)
            ON CONFLICT(admin_user_id,nav_key) DO UPDATE
            SET last_seen_at=GREATEST(admin_nav_read_state.last_seen_at,EXCLUDED.last_seen_at)
            RETURNING last_seen_at
        `, [adminUserId, keyName, seenAt]);
        return { area:key, seen_at:result.rows[0].last_seen_at };
    });
}

module.exports = { AREAS, NAV_PREFIX, area, navKey, list, markSeen, latestFor };
