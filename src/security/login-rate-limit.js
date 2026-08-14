'use strict';

const crypto = require('crypto');
const { query } = require('../db');

const DEFAULT_WINDOW_MS = 15 * 60 * 1000;
const DEFAULT_MAX_ATTEMPTS = 10;

function bucketKey(identifier, secret) {
    return crypto.createHmac('sha256', secret)
        .update(String(identifier || 'unknown'))
        .digest('hex');
}

async function consumeLoginAttempt(identifier, options = {}) {
    const secret = options.secret || process.env.SESSION_SECRET || '';
    if (!secret) throw new Error('SESSION_SECRET is required for login rate limiting');

    const windowMs = Number(options.windowMs || DEFAULT_WINDOW_MS);
    const maxAttempts = Number(options.maxAttempts || DEFAULT_MAX_ATTEMPTS);
    if (!Number.isFinite(windowMs) || windowMs < 1000) throw new Error('Invalid login rate-limit window');
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) throw new Error('Invalid login rate-limit maximum attempts');

    const key = bucketKey(identifier, secret);
    const result = await query(`
        INSERT INTO login_rate_limits (bucket_key, window_started_at, attempt_count, updated_at)
        VALUES ($1, NOW(), 1, NOW())
        ON CONFLICT (bucket_key) DO UPDATE SET
            window_started_at = CASE
                WHEN login_rate_limits.window_started_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond') THEN NOW()
                ELSE login_rate_limits.window_started_at
            END,
            attempt_count = CASE
                WHEN login_rate_limits.window_started_at <= NOW() - ($2::bigint * INTERVAL '1 millisecond') THEN 1
                ELSE login_rate_limits.attempt_count + 1
            END,
            updated_at = NOW()
        RETURNING attempt_count,
                  GREATEST(0, CEIL(EXTRACT(EPOCH FROM ((window_started_at + ($2::bigint * INTERVAL '1 millisecond')) - NOW()))))::integer AS retry_after_seconds
    `, [key, windowMs]);

    const row = result.rows[0];
    return {
        allowed: row.attempt_count <= maxAttempts,
        attemptCount: row.attempt_count,
        retryAfterSeconds: row.retry_after_seconds,
        maxAttempts,
        windowMs
    };
}

async function pruneLoginRateLimits(options = {}) {
    const olderThanMs = Number(options.olderThanMs || 24 * 60 * 60 * 1000);
    if (!Number.isFinite(olderThanMs) || olderThanMs < DEFAULT_WINDOW_MS) {
        throw new Error('Invalid login rate-limit retention window');
    }
    const result = await query(
        `DELETE FROM login_rate_limits
         WHERE updated_at < NOW() - ($1::bigint * INTERVAL '1 millisecond')`,
        [olderThanMs]
    );
    return result.rowCount;
}

module.exports = {
    DEFAULT_WINDOW_MS,
    DEFAULT_MAX_ATTEMPTS,
    bucketKey,
    consumeLoginAttempt,
    pruneLoginRateLimits
};
