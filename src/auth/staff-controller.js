'use strict';

const express = require('express');
const crypto = require('crypto');
const auth = require('./service');
const csrf = require('./csrf');

function regenerate(req) {
    return new Promise((resolve, reject) => {
        req.session.regenerate(error => error ? reject(error) : resolve());
    });
}

function save(req) {
    return new Promise((resolve, reject) => {
        req.session.save(error => error ? reject(error) : resolve());
    });
}

function destroy(req) {
    return new Promise(resolve => {
        if (!req.session) return resolve();
        req.session.destroy(() => resolve());
    });
}

function pending(req) {
    const value = req.session?.pendingStaffAuth;
    if (!value) return null;
    if (Date.now() - Number(value.startedAt || 0) > 10 * 60 * 1000) return null;
    return value;
}

function requirePending(req, res, next) {
    if (pending(req)) return next();
    return res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function destination(role) {
    return role === 'reseller' ? '/reseller' : '/admin';
}

function timingSafeTextEqual(leftValue, rightValue) {
    const left = Buffer.from(String(leftValue || ''), 'utf8');
    const right = Buffer.from(String(rightValue || ''), 'utf8');
    return left.length > 0 && left.length === right.length && crypto.timingSafeEqual(left, right);
}

function adminEnrollmentApproved(value) {
    const expected = String(process.env.ADMIN_2FA_ENROLLMENT_TOKEN || '');
    if (expected.length < 32) return false;
    return timingSafeTextEqual(expected, value);
}

async function establishAuthenticatedSession(req, user) {
    if (!Number.isInteger(Number(user.legacy_numeric_id))) {
        throw new Error('This staff identity has not completed legacy compatibility migration');
    }
    await regenerate(req);
    req.session.authUserId = user.id;
    req.session.authRole = user.role;
    req.session.authUsername = user.username;
    req.session.authSessionVersion = Number(user.session_version);
    req.session.userType = user.role;
    if (user.role === 'admin') req.session.adminId = Number(user.legacy_numeric_id);
    if (user.role === 'reseller') req.session.resellerId = Number(user.legacy_numeric_id);
    req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
    const hours = Math.max(1, Math.min(24, Number(process.env.STAFF_SESSION_HOURS || 12)));
    req.session.cookie.maxAge = hours * 60 * 60 * 1000;
    await save(req);
    try {
        await auth.registerSession(req, user);
    } catch (error) {
        await destroy(req);
        throw error;
    }
}

function loginPage(req, res) {
    const message = req.query.session === 'expired'
        ? 'Your session expired. Sign in again.'
        : req.query.locked
            ? 'Authentication was temporarily locked after repeated failures.'
            : null;
    return res.render('auth/staff-login', {
        siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
        error: null,
        message,
        csrfToken: csrf.token(req)
    });
}

async function loginSubmit(req, res) {
    if (!csrf.verify(req)) {
        return res.status(403).render('auth/staff-login', {
            siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
            error: 'The sign-in form expired. Please try again.',
            message: null,
            csrfToken: csrf.token(req)
        });
    }

    try {
        const user = await auth.authenticateStaff(req.body.username, req.body.password, req);
        if (!user || !Number.isInteger(Number(user.legacy_numeric_id))) {
            return res.status(401).render('auth/staff-login', {
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                error: 'Invalid username or password.',
                message: null,
                csrfToken: csrf.token(req)
            });
        }

        await regenerate(req);
        req.session.pendingStaffAuth = {
            userId: user.id,
            role: user.role,
            username: user.username,
            legacyId: Number(user.legacy_numeric_id),
            startedAt: Date.now(),
            attempts: 0
        };
        req.session.csrfToken = crypto.randomBytes(32).toString('base64url');
        req.session.cookie.maxAge = 10 * 60 * 1000;
        await save(req);

        if (auth.requiresTwoFactor(user)) {
            return res.redirect(user.totp_enabled ? '/auth/2fa' : '/auth/2fa/setup');
        }

        await establishAuthenticatedSession(req, user);
        return res.redirect(destination(user.role));
    } catch (error) {
        console.error('Native staff login failed:', error.message);
        return res.status(503).render('auth/staff-login', {
            siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
            error: 'Authentication is temporarily unavailable.',
            message: null,
            csrfToken: csrf.token(req)
        });
    }
}

async function logout(req, res) {
    const userId = req.session?.authUserId;
    const sid = req.sessionID;
    try {
        if (userId) await auth.markSessionLoggedOut(sid, userId, req);
    } catch (error) {
        console.warn('Could not record logout:', error.message);
    }
    await destroy(req);
    return res.redirect('/login');
}

function createAuthRouter() {
    const router = express.Router();
    router.use('/auth/2fa', noStore);

    router.get('/auth/2fa', requirePending, async (req, res) => {
        const p = pending(req);
        const user = await auth.getStaffById(p.userId);
        if (!user?.totp_enabled) return res.redirect('/auth/2fa/setup');
        return res.render('auth/2fa-challenge', {
            siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
            username: p.username,
            error: null,
            csrfToken: csrf.token(req)
        });
    });

    router.post('/auth/2fa', requirePending, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const p = pending(req);
        const ok = await auth.verifySecondFactor(p.userId, req.body.code, req);
        if (!ok) {
            p.attempts = Number(p.attempts || 0) + 1;
            req.session.pendingStaffAuth = p;
            if (p.attempts >= 5) {
                await auth.lockAfterSecondFactorFailures(p.userId, req);
                await destroy(req);
                return res.redirect('/login?locked=1');
            }
            return res.status(401).render('auth/2fa-challenge', {
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                username: p.username,
                error: 'Invalid authenticator or recovery code.',
                csrfToken: csrf.token(req)
            });
        }
        const user = await auth.getStaffById(p.userId);
        await establishAuthenticatedSession(req, user);
        return res.redirect(destination(user.role));
    });

    router.get('/auth/2fa/setup', requirePending, async (req, res) => {
        const p = pending(req);
        const user = await auth.getStaffById(p.userId);
        if (user?.totp_enabled) return res.redirect('/auth/2fa');
        const enrollment = await auth.beginTotpEnrollment(p.userId);
        return res.render('auth/2fa-setup', {
            siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
            username: p.username,
            secret: enrollment.secret,
            uri: enrollment.uri,
            requiresApproval: p.role === 'admin',
            error: null,
            csrfToken: csrf.token(req)
        });
    });

    router.post('/auth/2fa/setup', requirePending, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const p = pending(req);
        if (p.role === 'admin' && !adminEnrollmentApproved(req.body.enrollmentToken)) {
            await auth.recordEvent({ userId: p.userId, eventType: '2fa.enrollment_approval_failed', success: false, req });
            return res.status(403).render('auth/message', {
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                title: 'Administrator enrollment not approved',
                message: 'The independent enrollment approval was not accepted. No two-factor setting was changed.',
                link: '/auth/2fa/setup',
                linkText: 'Return to setup'
            });
        }
        const recoveryCodes = await auth.confirmTotpEnrollment(p.userId, req.body.code, req);
        if (!recoveryCodes) {
            return res.status(401).render('auth/message', {
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                title: 'Two-factor setup failed',
                message: 'The code did not match. Return to setup and try again.',
                link: '/auth/2fa/setup',
                linkText: 'Return to setup'
            });
        }
        const user = await auth.getStaffById(p.userId);
        await establishAuthenticatedSession(req, user);
        res.setHeader('Cache-Control', 'no-store, private, max-age=0');
        return res.render('auth/recovery-codes', {
            siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
            recoveryCodes,
            continueUrl: destination(user.role)
        });
    });

    return router;
}

module.exports = { loginPage, loginSubmit, logout, createAuthRouter, establishAuthenticatedSession, adminEnrollmentApproved };
