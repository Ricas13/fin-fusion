'use strict';

const crypto = require('crypto');

function token(req) {
    if (!req.session) throw new Error('Session is required for CSRF protection');
    if (!req.session.csrfToken) req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
    return req.session.csrfToken;
}

function verify(req) {
    const expected = String(req.session?.csrfToken || '');
    const supplied = String(req.body?._csrf || req.get?.('x-csrf-token') || '');
    if (!expected || !supplied) return false;
    const left = Buffer.from(expected, 'utf8');
    const right = Buffer.from(supplied, 'utf8');
    return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function requireCsrf(req, res, next) {
    if (verify(req)) return next();
    return res.status(403).send('Invalid or expired security token');
}

module.exports = { token, verify, requireCsrf };
