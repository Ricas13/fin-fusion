'use strict';

const { consumeLoginAttempt, pruneLoginRateLimits } = require('./src/security/login-rate-limit');

const IS_PRODUCTION = process.env.NODE_ENV === 'production';
const WINDOW_MS = Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS || 15 * 60 * 1000);
const MAX_ATTEMPTS = Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS || 10);
let lastPruneAt = 0;

function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'unknown';
}

function installPersistentLoginRateLimit() {
    const expressPath = require.resolve('express');
    const realExpress = require(expressPath);

    function loginRateLimitMiddleware(req, res, next) {
        if (req.method !== 'POST' || req.path !== '/login') return next();

        consumeLoginAttempt(clientIp(req), {
            windowMs: WINDOW_MS,
            maxAttempts: MAX_ATTEMPTS,
            secret: process.env.SESSION_SECRET
        }).then(result => {
            if (Date.now() - lastPruneAt > 60 * 60 * 1000) {
                lastPruneAt = Date.now();
                pruneLoginRateLimits().catch(error => {
                    console.warn(`Login rate-limit cleanup failed: ${error.message}`);
                });
            }

            res.setHeader('X-RateLimit-Limit', String(result.maxAttempts));
            res.setHeader('X-RateLimit-Remaining', String(Math.max(0, result.maxAttempts - result.attemptCount)));
            if (!result.allowed) {
                res.setHeader('Retry-After', String(Math.max(1, result.retryAfterSeconds)));
                return res.status(429).send('Too many login attempts. Try again later.');
            }
            next();
        }).catch(error => {
            console.error(`Persistent login rate limiter unavailable: ${error.message}`);
            if (IS_PRODUCTION) {
                res.setHeader('Retry-After', '30');
                return res.status(503).send('Login temporarily unavailable. Try again shortly.');
            }
            next();
        });
    }

    function wrappedExpress(...args) {
        const app = realExpress(...args);
        app.use(loginRateLimitMiddleware);
        return app;
    }

    Object.assign(wrappedExpress, realExpress);
    wrappedExpress.application = realExpress.application;
    wrappedExpress.request = realExpress.request;
    wrappedExpress.response = realExpress.response;
    require.cache[expressPath].exports = wrappedExpress;
}

installPersistentLoginRateLimit();
