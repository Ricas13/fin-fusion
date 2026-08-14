'use strict';

const express = require('express');
const crypto = require('crypto');
const auth = require('../auth/service');
const csrf = require('../auth/csrf');
const admin2faPolicy = require('../auth/admin-2fa-policy');

function requireNativeAdmin(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function fingerprint(value) {
    return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 12);
}

function createAdminSecurityRouter() {
    const router = express.Router();
    router.use('/admin/security', requireNativeAdmin, noStore);

    // Loaded by every modern admin surface. When administrator 2FA is optional,
    // routine step-up fields disappear entirely; actual TOTP setup/recovery
    // pages use their own auth stylesheet and remain unaffected.
    router.get('/admin/security/policy.css', async (_req, res, next) => {
        try {
            const required = await admin2faPolicy.required();
            res.type('text/css');
            return res.send(required ? '' : `
.formGroup:has(input[name="code"][autocomplete="one-time-code"]) { display:none !important; }
`);
        } catch (error) { return next(error); }
    });

    router.get('/admin/security', async (req, res, next) => {
        try {
            const overview = await auth.getSecurityOverview(req.session.authUserId);
            if (!overview) return res.redirect('/login?session=expired');
            const sessions = overview.sessions.map(s => ({
                createdAt: s.created_at,
                lastSeenAt: s.last_seen_at,
                expiresAt: s.expires_at,
                revokedAt: s.revoked_at,
                isCurrent: s.session_id === req.sessionID,
                fingerprint: fingerprint(s.user_agent_hash)
            }));
            return res.render('admin/security', {
                siteName: process.env.SITE_NAME || 'CAPTaINFiN',
                user: overview.user,
                sessions,
                events: overview.events,
                recoveryCodesRemaining: overview.recoveryCodesRemaining,
                admin2faRequired: await admin2faPolicy.required(),
                csrfToken: csrf.token(req),
                message: req.query.message || null,
                error: req.query.error || null
            });
        } catch (error) { return next(error); }
    });

    router.post('/admin/security/2fa-policy', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const required = req.body.requireAdminTwoFactor === 'on' || req.body.requireAdminTwoFactor === 'true';
            await admin2faPolicy.setRequired(required, req.session.authUserId);
            const overview = await auth.getSecurityOverview(req.session.authUserId);
            let message = required
                ? 'Administrator 2FA is now required.'
                : 'Administrator 2FA is now optional. Existing authenticator enrollment was kept.';
            if (required && !overview?.user?.totp_enabled) {
                message += ' Sign out and sign back in to complete authenticator setup.';
            }
            return res.redirect('/admin/security?message=' + encodeURIComponent(message));
        } catch (error) { return next(error); }
    });

    router.get('/admin/security/password', (req, res) => {
        return res.render('admin/security-password', {
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            csrfToken: csrf.token(req)
        });
    });

    router.get('/admin/security/recovery', async (req, res, next) => {
        try {
            const overview = await auth.getSecurityOverview(req.session.authUserId);
            return res.render('admin/security-recovery', {
                siteName: process.env.SITE_NAME || 'CAPTaINFiN',
                enabled: !!overview?.user?.totp_enabled,
                remaining: overview?.recoveryCodesRemaining || 0,
                csrfToken: csrf.token(req)
            });
        } catch (error) { return next(error); }
    });

    router.post('/admin/security/sessions/revoke-others', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await auth.revokeOtherSessions(req.session.authUserId, req.sessionID, req);
            return res.redirect('/admin/security?message=' + encodeURIComponent('Other staff sessions were signed out.'));
        } catch (error) { return next(error); }
    });

    router.post('/admin/security/password', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        if (req.body.newPassword !== req.body.confirmPassword) {
            return res.redirect('/admin/security?error=' + encodeURIComponent('New passwords do not match.'));
        }
        try {
            const changed = await auth.changePassword(
                req.session.authUserId,
                req.body.currentPassword,
                req.body.newPassword,
                req.sessionID,
                req
            );
            if (!changed) return res.redirect('/admin/security?error=' + encodeURIComponent('Current password was not accepted.'));
            req.session.authSessionVersion = Number(changed.sessionVersion);
            await new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
            return res.redirect('/admin/security?message=' + encodeURIComponent('Password changed. Other staff sessions were revoked.'));
        } catch (error) {
            return res.redirect('/admin/security?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/admin/security/recovery/regenerate', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const codes = await auth.regenerateRecoveryCodes(req.session.authUserId, req.body.code, req);
            if (!codes) return res.redirect('/admin/security?error=' + encodeURIComponent('Authenticator code was not accepted.'));
            return res.render('auth/recovery-codes', {
                siteName: process.env.SITE_NAME || 'CAPTaINFiN',
                recoveryCodes: codes,
                continueUrl: '/admin/security'
            });
        } catch (error) { return next(error); }
    });

    router.use('/admin/security', (error, _req, res, _next) => {
        console.error('Admin security route error:', error.message);
        return res.status(500).render('auth/message', {
            siteName: process.env.SITE_NAME || 'CAPTaINFiN',
            title: 'Security request failed',
            message: 'The request could not be completed safely. No security settings were changed.',
            link: '/admin/security',
            linkText: 'Return to Security'
        });
    });

    return router;
}

module.exports = { createAdminSecurityRouter };
