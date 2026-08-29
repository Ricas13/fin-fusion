'use strict';

const crypto = require('crypto');
const { query } = require('../db');

const memoryBuckets = new Map();
const MEMORY_BUCKET_MAX = 10000;

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

function pruneMemoryBuckets(now = Date.now()) {
    for (const [bucket, state] of memoryBuckets) {
        if (Number(state?.expiresAt || 0) <= now) memoryBuckets.delete(bucket);
    }
    while (memoryBuckets.size > MEMORY_BUCKET_MAX) {
        const oldest = memoryBuckets.keys().next().value;
        if (oldest === undefined) break;
        memoryBuckets.delete(oldest);
    }
}

function memoryAttempt(bucket, seconds) {
    const now = Date.now();
    const windowMs = seconds * 1000;
    let state = memoryBuckets.get(bucket);
    if (!state || state.expiresAt <= now) {
        state = { attemptCount: 1, expiresAt: now + windowMs };
    } else {
        state = { ...state, attemptCount: state.attemptCount + 1 };
    }
    memoryBuckets.delete(bucket);
    memoryBuckets.set(bucket, state);
    if (memoryBuckets.size > MEMORY_BUCKET_MAX) pruneMemoryBuckets(now);
    return {
        attemptCount: state.attemptCount,
        retryAfter: Math.max(1, Math.ceil((state.expiresAt - now) / 1000))
    };
}

function clearMemoryBuckets() {
    memoryBuckets.clear();
}

function sendLimited(res, reasonHeader, retryAfter) {
    res.setHeader('Retry-After', String(Math.max(1, retryAfter)));
    res.setHeader('X-CAPTAiNFiN-429-Reason', reasonHeader);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(429).send('Too many requests. Please try again shortly.');
}

function middleware({ scope, max = 10, windowSeconds = 60, identity = null, reason = 'rate_limit', backend = 'database' } = {}) {
    const keyScope = cleanScope(scope);
    const limit = Math.max(1, Math.min(1000, Number(max) || 10));
    const seconds = Math.max(1, Math.min(86400, Number(windowSeconds) || 60));
    const reasonHeader = String(reason || 'rate_limit').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-').slice(0, 64) || 'rate_limit';
    const storage = String(backend || 'database').toLowerCase() === 'memory' ? 'memory' : 'database';

    return async function routeRateLimit(req, res, next) {
        const bucket = `route:${keyScope}:${requestIdentity(req, identity)}`;

        // Availability-sensitive, read-only protocol routes may opt into a
        // bounded per-process bucket. This keeps abuse control in place without
        // making an overloaded/shared PostgreSQL pool a prerequisite for every
        // protocol GET. Sensitive authentication and mutation limits continue
        // to use the default database backend and fail closed below.
        if (storage === 'memory') {
            const result = memoryAttempt(bucket, seconds);
            if (result.attemptCount > limit) return sendLimited(res, reasonHeader, result.retryAfter);
            return next();
        }

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
                return sendLimited(res, reasonHeader, retryAfter);
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

module.exports = { middleware, requestIdentity, hashIdentity, cleanScope, memoryAttempt, clearMemoryBuckets, pruneMemoryBuckets };
