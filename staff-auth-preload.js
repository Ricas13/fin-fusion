'use strict';

require('dotenv').config();

if (!process.env.DATABASE_URL) {
    if (process.env.NODE_ENV === 'production') throw new Error('Production requires PostgreSQL-backed staff authentication');
    return;
}

if (process.env.NODE_ENV === 'production') {
    const { keyFromEnv } = require('./src/security/purpose-crypto');
    keyFromEnv('AUTH_ENCRYPTION_KEY');
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

// Administrator 2FA is a runtime policy. When it is optional, an enrolled
// authenticator remains stored but is not demanded at login or for routine
// administrative writes. Reseller 2FA keeps its existing policy semantics.
const admin2faPolicy = require('./src/auth/admin-2fa-policy');
const authService = require('./src/auth/service');
const baseRequiresTwoFactor = authService.requiresTwoFactor;
const baseVerifySecondFactor = authService.verifySecondFactor;

authService.requiresTwoFactor = function requiresTwoFactorWithRuntimePolicy(user) {
    if (user?.role === 'admin') return admin2faPolicy.requiredSync();
    return baseRequiresTwoFactor(user);
};

authService.verifySecondFactor = async function verifySecondFactorWithRuntimePolicy(userId, token, req) {
    const user = await authService.getStaffById(userId);
    if (user?.role === 'admin' && !(await admin2faPolicy.required())) {
        await authService.recordEvent({
            userId,
            eventType: '2fa.step_up_not_required',
            success: true,
            req,
            metadata: { policy: 'optional-runtime', enrolled: Boolean(user.totp_enabled) }
        });
        return true;
    }
    return baseVerifySecondFactor(userId, token, req);
};

const express = require('express');
const controller = require('./src/auth/staff-controller');
const dashboard = require('./src/platform/admin-dashboard');
const resellerPortal = require('./src/platform/reseller-portal');
const originalGet = express.application.get;
const originalPost = express.application.post;
const currentListen = express.application.listen;

const resellerGetRoutes = {
    '/reseller': resellerPortal.dashboardPage,
    '/reseller/expiring-clients': resellerPortal.expiringClientsRedirect,
    '/reseller/expired-clients': resellerPortal.expiredClientsRedirect,
    '/reseller/credit-history': resellerPortal.creditHistoryPage,
    '/reseller/client/:id/credentials': resellerPortal.credentialsPage
};
const resellerPostRoutes = {
    '/reseller/trial/create': resellerPortal.createTrialClient,
    '/reseller/trial/extend': resellerPortal.extendClient,
    '/reseller/client/reset-password': resellerPortal.resetClientPassword,
    '/reseller/client/update-note': resellerPortal.updateClientNote,
    '/reseller/client/toggle': resellerPortal.toggleClient,
    '/reseller/client/delete': resellerPortal.deleteClientStub,
    '/reseller/content-request': resellerPortal.contentRequest,
    '/reseller/message/read': resellerPortal.messageReadStub
};

async function adminPolicyAwareLogin(req, res, next) {
    try {
        await admin2faPolicy.required();
        return controller.loginSubmit(req, res, next);
    } catch (error) {
        return next(error);
    }
}

express.application.get = function staffGet(path, ...handlers) {
    if (path === '/login' && handlers.length) return originalGet.call(this, path, controller.loginPage);
    if (path === '/logout' && handlers.length) return originalGet.call(this, path, controller.logout);
    if (path === '/admin' && handlers.length) return originalGet.call(this, path, dashboard.dashboardPage);
    if (resellerGetRoutes[path] && handlers.length) {
        return originalGet.call(this, path, resellerPortal.gate, resellerPortal.noStore, resellerGetRoutes[path]);
    }
    return originalGet.call(this, path, ...handlers);
};

express.application.post = function staffPost(path, ...handlers) {
    if (path === '/login' && handlers.length) return originalPost.call(this, path, adminPolicyAwareLogin);
    if (resellerPostRoutes[path] && handlers.length) {
        return originalPost.call(this, path, resellerPortal.gate, resellerPortal.noStore, resellerPostRoutes[path]);
    }
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
