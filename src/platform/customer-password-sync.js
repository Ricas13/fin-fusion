'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const provisioning = require('../jellyfin/resilient-provisioning');
const requestUsers = require('../integrations/request-user-sync');

function requireCustomer(req, res, next) {
    if (req.session?.customerId && req.session?.customerUserId) return next();
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
}

function createCustomerPasswordSyncRouter() {
    const router = express.Router();

    // Mounted before the legacy customer router so a password entered once in
    // the CAPTaINFiN portal can be applied to both Jellyfin and the central
    // request service. The plaintext password is never stored by CAPTaINFiN.
    router.post('/account/jellyfin/:accountId/password', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        const password = String(req.body.password || '');
        try {
            await provisioning.setJellyfinPassword(req.session.customerId, req.params.accountId, password);
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message || 'Jellyfin password could not be updated.'));
        }

        try {
            const config = await requestUsers.configuration();
            if (!config.configured) {
                return res.redirect('/account?message=' + encodeURIComponent('Jellyfin password updated.'));
            }
            const access = await requestUsers.requestAccessForCustomer(req.session.customerId);
            if (access?.access_suspended) {
                return res.redirect('/account?message=' + encodeURIComponent('Jellyfin password updated. Request access is currently suspended.'));
            }
            await requestUsers.setCustomerPassword(req.session.customerId, password);
            return res.redirect('/account?message=' + encodeURIComponent('Jellyfin and request-site passwords updated.'));
        } catch (error) {
            await requestUsers.markPasswordSyncFailure(req.session.customerId, error).catch(() => {});
            return res.redirect('/account?error=' + encodeURIComponent('Jellyfin password was updated, but the request-site password could not be synchronized. Use the request password control to retry.'));
        }
    });

    return router;
}

module.exports = { createCustomerPasswordSyncRouter };
