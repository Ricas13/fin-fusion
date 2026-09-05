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
    message: 'Too many Free Server restore attempts. Please try again shortly.'
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

    // Compatibility URL retained so existing bookmarks/forms do not break. The
    // operation now releases only the Free inactivity hold and reprovisions a
    // new enabled account; there is no disabled Jellyfin account to toggle.
    router.post('/admin/users/:customerId/jellyfin/re-enable', reenableLimit, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const result = await restore.restoreDisabledFreeAccess(req.params.customerId, {
                actorUserId: req.session.authUserId,
                reconcile: customerId => provisioning.reconcileCustomer(customerId)
            });
            if (!result.enabled) {
                return res.redirect(accessPath(req.params.customerId, 'error', 'Free Server access was released from inactivity removal, but a new enabled Jellyfin account was not provisioned. Check reconciliation status and retry.'));
            }
            return res.redirect(accessPath(req.params.customerId, 'message', 'Free Server access restored. A new enabled Jellyfin account is present and activity monitoring starts a fresh observation window.'));
        } catch (error) {
            return res.redirect(accessPath(req.params.customerId, 'error', `Could not restore Free Server access. ${String(error?.message || error).slice(0, 300)}`));
        }
    });

    return router;
}

module.exports = { createAdminJellyfinReenableRouter };
