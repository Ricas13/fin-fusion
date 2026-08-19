'use strict';

const { query, transaction } = require('../db');

const AREAS = new Set(['customers', 'orders', 'tickets']);

function area(value) {
    const key = String(value || '').trim().toLowerCase();
    if (!AREAS.has(key)) throw new Error('Invalid operator read area.');
    return key;
}

async function list(adminUserId) {
    if (!adminUserId) return {};
    const result = await query(
        `SELECT area,seen_at FROM admin_operator_read_cursors WHERE admin_user_id=$1`,
        [adminUserId]
    );
    return Object.fromEntries(result.rows.map(row => [row.area, row.seen_at]));
}

async function latestFor(client, key) {
    if (key === 'customers') {
        return (await client.query(`SELECT COALESCE(MAX(created_at),NOW()) seen_at FROM customers WHERE created_at>NOW()-INTERVAL '7 days'`)).rows[0].seen_at;
    }
    if (key === 'orders') {
        return (await client.query(`SELECT COALESCE(MAX(created_at),NOW()) seen_at FROM subscriptions WHERE created_at>NOW()-INTERVAL '7 days' AND source IN ('stripe','paypal') AND status IN ('active','trialing','past_due','paused')`)).rows[0].seen_at;
    }
    return (await client.query(`SELECT COALESCE(MAX(COALESCE(last_customer_reply_at,created_at)),NOW()) seen_at FROM support_tickets WHERE status IN ('open','awaiting_staff')`)).rows[0].seen_at;
}

async function markSeen(adminUserId, value) {
    if (!adminUserId) throw new Error('Administrator identity is required.');
    const key = area(value);
    return transaction(async client => {
        const seenAt = await latestFor(client, key);
        const result = await client.query(`
            INSERT INTO admin_operator_read_cursors(admin_user_id,area,seen_at)
            VALUES($1,$2,$3)
            ON CONFLICT(admin_user_id,area) DO UPDATE
            SET seen_at=GREATEST(admin_operator_read_cursors.seen_at,EXCLUDED.seen_at),updated_at=NOW()
            RETURNING area,seen_at
        `, [adminUserId, key, seenAt]);
        return result.rows[0];
    });
}

module.exports = { AREAS, area, list, markSeen, latestFor };
