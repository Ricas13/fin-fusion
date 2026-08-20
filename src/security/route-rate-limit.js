'use strict';

const crypto = require('crypto');
const { query } = require('../db');

function cleanScope(value) {
    const scope = String(value || '').trim().toLowerCase().replace(/[^a-z0-9:_-]/g, '-').slice(0, 80);
    if (!scope) throw new Error('Rate-limit scope is required');
    return scope;
}

function hashIdentity(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 40);
}

function requestIdentity(req, explicitIdentity = null) {
    let supplied = null;
    try {
        supplied = typeof explicitIdentity === 'function' ? explicitIdentity(req) : explicitIdentity;
    } catch (_) {
        supplied = null;
    }
    if (supplied !== null && supplied !== undefined && String(supplied).trim()) {
        return hashIdentity(`explicit:${String(supplied).trim()}`);
    }
    const authenticated = req.session?.authUserId || req.session?.customerUserId || req.session?.customerId || null;
    const fallback = req.sessionID || req.ip || req.socket?.remoteAddress || 'unknown';
    const raw = authenticated ? `user:${authenticated}` : `request:${fallback}`;
    return hashIdentity(raw);
}

function middleware({ scope, max = 10, windowSeconds = 60, identity = null, reason = 'rate_limit' } = {}) {
    const keyScope = cleanScope(scope);
    const limit = Math.max(1, Math.min(1000, Number(max) || 10));
    const seconds = Math.max(1, Math.min(86400, Number(windowSeconds) || 60));
    const reasonHeader = String(reason || 'rate_limit').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64) || 'rate_limit';

    return async function routeRateLimit(req, res, next) {
        const bucket = `route:${keyScope}:${requestIdentity(req, identity)}`;
        try {
            const result = await query(`
                INSERT INTO login_rate_limits(bucket_key,window_started_at,attempt_count,updated_at)
                VALUES($1,NOW(),1,NOW())
                ON CONFLICT(bucket_key) DO UPDATE SET
                    attempt_count=CASE
                        WHEN login_rate_limits.window_started_at <= NOW()-($2::int * INTERVAL '1 second') THEN 1
                        ELSE login_rate_limits.attempt_count+1
                    END,
                    window_started_at=CASE
                        WHEN login_rate_limits.window_started_at <= NOW()-($2::int * INTERVAL '1 second') THEN NOW()
                        ELSE login_rate_limits.window_started_at
                    END,
                    updated_at=NOW()
                RETURNING attempt_count,
                    GREATEST(1,CEIL(EXTRACT(EPOCH FROM (window_started_at+($2::int * INTERVAL '1 second')-NOW()))))::int AS retry_after
            `, [bucket, seconds]);
            const count = Number(result.rows[0]?.attempt_count || 0);
            if (count > limit) {
                const retryAfter = Math.max(1, Number(result.rows[0]?.retry_after || seconds));
                res.setHeader('Retry-After', String(retryAfter));
                res.setHeader('X-CAPTAiNFiN-429-Reason', reasonHeader);
                res.setHeader('Cache-Control', 'no-store');
                return res.status(429).send('Too many requests. Please try again shortly.');
            }
            return next();
        } catch (error) {
            console.error(`Rate limiter ${keyScope} failed:`, error.message);
            // Sensitive mutation/authentication limits fail closed if the shared
            // backing store is unavailable rather than silently disabling abuse
            // protection on one application replica.
            res.setHeader('Cache-Control', 'no-store');
            return res.status(503).send('Security rate limiting is temporarily unavailable. Try again shortly.');
        }
    };
}

module.exports = { middleware, requestIdentity, hashIdentity, cleanScope };