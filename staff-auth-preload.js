'use strict';

require('dotenv').config();

if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production requires PostgreSQL-backed staff authentication');
    return;
}

if (process.env.NODE_ENV === 'production') {
    const { keyFromEnv } = require('./src/security/purpose-crypto');
    keyFromEnv('AUTH_ENCRYPTION_KEY');
    if (process.env.REQUIRE_ADMIN_2FA === 'false') throw new Error('Administrator 2FA cannot be disabled in production');
}

const sessionPath = require.resolve('express-session');
const currentSessionFactory = require(sessionPath);
const { guardSession } = require('./src/auth/session-guard');

function guardedSession(options = {}) {
    const base = currentSessionFactory(options);
    return function staffSessionGuard(req, res, next) {
        base(req, res, error => {
            if (error) return next(error);
            Promise.resolve(guardSession(req, res, next)).catch(next);
        });
    };
}
Object.assign(guardedSession, currentSessionFactory);
require.cache[sessionPath].exports = guardedSession;

const express = require('express');
const controller = require('./src/auth/staff-controller');
const originalGet = express.application.get;
const originalPost = express.application.post;
const currentListen = express.application.listen;

express.application.get = function staffGet(path, ...handlers) {
    if (path === '/login' && handlers.length) return originalGet.call(this, path, controller.loginPage);
    if (path === '/logout' && handlers.length) return originalGet.call(this, path, controller.logout);
    return originalGet.call(this, path, ...handlers);
};

express.application.post = function staffPost(path, ...handlers) {
    if (path === '/login' && handlers.length) return originalPost.call(this, path, controller.loginSubmit);
    return originalPost.call(this, path, ...handlers);
};

express.application.listen = function staffAuthListen(...args) {
    if (!this.locals.__staffAuthRoutesMounted) {
        this.locals.__staffAuthRoutesMounted = true;
        this.use(controller.createAuthRouter());
        try {
            const { createAdminSecurityRouter } = require('./src/platform/admin-security');
            this.use(createAdminSecurityRouter());
        } catch (error) {
            if (error.code !== 'MODULE_NOT_FOUND') throw error;
        }
    }
    return currentListen.apply(this, args);
};
