'use strict';

const express = require('express');
const crypto = require('crypto');
const { query } = require('../db');
const auth = require('../auth/service');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');

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

function save(req) {
    return new Promise((resolve, reject) => req.session.save(error => error ? reject(error) : resolve()));
}

async function setAdminTwoFactorPolicy(required, userId) {
    await query(`
        INSERT INTO platform_settings(setting_key,setting_value,updated_by,updated_at)
        VALUES('platform',jsonb_build_object('requireAdminTwoFactor',$1::boolean),$2,NOW())
        ON CONFLICT(setting_key) DO UPDATE
        SET setting_value=COALESCE(platform_settings.setting_value,'{}'::jsonb) || EXCLUDED.setting_value,
            updated_by=EXCLUDED.updated_by,
            updated_at=NOW()
    `, [required, userId]);
    await runtimeSettings.reload();
}

function createAdminSecurityRouter() {
    const router = express.Router();
    router.use('/admin/security', requireNativeAdmin, noStore);
    router.use('/admin/settings/admin-2fa', requireNativeAdmin, noStore);

    router.get('/admin/settings/admin-2fa', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
            return res.render('admin/security-policy', {
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                admin2faRequired: runtimeSettings.requireAdminTwoFactor(),
                csrfToken: csrf.token(req),
                message: req.query.message || null,
                error: req.query.error || null
            });
        } catch (error) { return next(error); }
    });

    router.get('/admin/security', async (req, res, next) => {
        try {
            await runtimeSettings.ensureLoaded();
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
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                user: overview.user,
                sessions,
                events: overview.events,
                recoveryCodesRemaining: overview.recoveryCodesRemaining,
                admin2faRequired: runtimeSettings.requireAdminTwoFactor(),
                csrfToken: csrf.token(req),
                message: req.query.message || null,
                error: req.query.error || null
            });
        } catch (error) { return next(error); }
    });

    router.get('/admin/security/password', (req, res) => {
        return res.render('admin/security-password', {
            siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
            csrfToken: csrf.token(req)
        });
    });

    router.get('/admin/security/recovery', async (req, res, next) => {
        try {
            const overview = await auth.getSecurityOverview(req.session.authUserId);
            return res.render('admin/security-recovery', {
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                enabled: !!overview?.user?.totp_enabled,
                remaining: overview?.recoveryCodesRemaining || 0,
                csrfToken: csrf.token(req)
            });
        } catch (error) { return next(error); }
    });

    router.post('/admin/security/2fa-policy', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const required = req.body.requireAdminTwoFactor === 'on';
            await setAdminTwoFactorPolicy(required, req.session.authUserId);
            const message = required
                ? 'Administrator 2FA is now required at sign-in.'
                : 'Administrator 2FA is now optional.';
            return res.redirect('/admin/settings/admin-2fa?message=' + encodeURIComponent(message));
        } catch (error) { return next(error); }
    });

    router.post('/admin/security/2fa/enable', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const user = await auth.getStaffById(req.session.authUserId);
            if (!user) return res.redirect('/login?session=expired');
            if (user.totp_enabled) {
                return res.redirect('/admin/security?message=' + encodeURIComponent('2FA is already enabled for this account.'));
            }
            req.session.pendingStaffAuth = {
                userId: user.id,
                role: user.role,
                username: user.username,
                legacyId: Number(user.legacy_numeric_id),
                startedAt: Date.now(),
                attempts: 0
            };
            await save(req);
            return res.redirect('/auth/2fa/setup');
        } catch (error) { return next(error); }
    });

    router.post('/admin/security/2fa/disable', async (req, res, next) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await runtimeSettings.ensureLoaded();
            if (runtimeSettings.requireAdminTwoFactor()) {
                return res.redirect('/admin/security?error=' + encodeURIComponent('Turn off the global 2FA requirement under Settings → Security before disabling this account\'s 2FA.'));
            }
            const disabled = await auth.disableTotp(req.session.authUserId, req.body.currentPassword, req);
            if (!disabled) return res.redirect('/admin/security?error=' + encodeURIComponent('Current password was not accepted.'));
            return res.redirect('/admin/security?message=' + encodeURIComponent('2FA disabled for this administrator account.'));
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
            await save(req);
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
                siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
                recoveryCodes: codes,
                continueUrl: '/admin/security'
            });
        } catch (error) { return next(error); }
    });

    router.use('/admin/security', (error, _req, res, _next) => {
        console.error('Admin security route error:', error.message);
        return res.status(500).render('auth/message', {
            siteName: process.env.SITE_NAME || 'CAPTAiNFiN',
            title: 'Security request failed',
            message: 'The request could not be completed safely. No security settings were changed.',
            link: '/admin/security',
            linkText: 'Return to Security'
        });
    });

    return router;
}

module.exports = { createAdminSecurityRouter, setAdminTwoFactorPolicy };
