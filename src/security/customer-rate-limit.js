'use strict';

const { query } = require('../db');

async function consume(bucketKey, { limit = 10, windowMs = 15 * 60 * 1000 } = {}) {
    const seconds = Math.max(1, Math.ceil(windowMs / 1000));
    const result = await query(`
        INSERT INTO login_rate_limits(bucket_key,window_started_at,attempt_count,updated_at)
        VALUES($1,NOW(),1,NOW())
        ON CONFLICT(bucket_key) DO UPDATE SET
          window_started_at=CASE WHEN login_rate_limits.window_started_at < NOW()-($3::int*INTERVAL '1 second') THEN NOW() ELSE login_rate_limits.window_started_at END,
          attempt_count=CASE WHEN login_rate_limits.window_started_at < NOW()-($3::int*INTERVAL '1 second') THEN 1 ELSE login_rate_limits.attempt_count+1 END,
          updated_at=NOW()
        RETURNING attempt_count,window_started_at
    `, [String(bucketKey).slice(0,300), Math.max(1, Number(limit) || 10), seconds]);
    const row = result.rows[0];
    const count = Number(row?.attempt_count || 0);
    const resetAt = new Date(new Date(row.window_started_at).getTime() + seconds * 1000);
    return { allowed: count <= limit, count, remaining: Math.max(0, limit - count), resetAt };
}

async function cleanup() {
    const result = await query(`DELETE FROM login_rate_limits WHERE updated_at < NOW()-INTERVAL '2 days'`);
    return result.rowCount;
}

module.exports = { consume, cleanup };
