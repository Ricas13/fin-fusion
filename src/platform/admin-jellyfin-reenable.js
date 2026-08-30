'use strict';

const express = require('express');
const { rateLimit } = require('express-rate-limit');
const csrf = require('../auth/csrf');
const restore = require('../entitlements/jellyfin-inactivity-restore');
const provisioning = require('../jellyfin/resilient-provisioning');

const reenableLimit = rateLimit({
    windowMs: 60_000,
    limit: 30,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    message: 'Too many re-enable attempts. Please try again shortly.'
});

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}

function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}

function accessPath(customerId, key, message) {
    return `/admin/users/${encodeURIComponent(customerId)}?tab=access&${encodeURIComponent(key)}=${encodeURIComponent(message)}`;
}

function createAdminJellyfinReenableRouter() {
    const router = express.Router();
    router.use('/admin/users', gate, noStore);

    // This route also inherits the shared DB-backed /admin mutation limiter from
    // admin-route-composition. Keep an explicit route-local limiter as defense in
    // depth so the sensitive mutation remains protected at its owning handler.
    router.post('/admin/users/:customerId/jellyfin/re-enable', reenableLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const result = await restore.restoreDisabledFreeAccess(req.params.customerId, {
                actorUserId: req.session.authUserId,
                reconcile: customerId => provisioning.reconcileCustomer(customerId)
            });
            if (result.blocked) {
                const blockers = result.remainingHolds.map(row => row.type).filter(Boolean).join(', ') || 'another access hold';
                return res.redirect(accessPath(req.params.customerId, 'error', `The inactivity disable was cleared, but Jellyfin is still blocked by ${blockers}. No unrelated hold was removed.`));
            }
            if (!result.enabled) {
                return res.redirect(accessPath(req.params.customerId, 'error', 'The inactivity disable was cleared, but Jellyfin has not confirmed the account as enabled yet. Check provisioning status and retry reconciliation.'));
            }
            return res.redirect(accessPath(req.params.customerId, 'message', 'Jellyfin access re-enabled. Free Server inactivity monitoring now has a fresh observation window; no playback activity was fabricated.'));
        } catch (error) {
            return res.redirect(accessPath(req.params.customerId, 'error', `Could not re-enable Jellyfin access. ${String(error?.message || error).slice(0, 300)}`));
        }
    });

    return router;
}

module.exports = { createAdminJellyfinReenableRouter };
