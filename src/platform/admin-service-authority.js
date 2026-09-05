'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const serviceAdminControl = require('../entitlements/service-admin-control');
const provisioning = require('../jellyfin/resilient-provisioning');
const requestUserSync = require('../integrations/request-user-sync');

function gate(req, res, next) {
    if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
    return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
    res.setHeader('Cache-Control', 'no-store, private, max-age=0');
    res.setHeader('Pragma', 'no-cache');
    next();
}
function safeLog(value, max = 500) {
    return String(value == null ? '' : value).replace(/[\r\n\t\u2028\u2029]+/g, ' ').slice(0, max);
}
function customerPath(customerId, key = '', message = '') {
    const notice = key ? `&${encodeURIComponent(key)}=${encodeURIComponent(message)}` : '';
    return `/admin/users/${encodeURIComponent(customerId)}?tab=access${notice}`;
}
async function resyncService(customerId, service) {
    if (service === 'jellyfin' || service === 'stremio') {
        await provisioning.reconcileCustomer(customerId);
        return;
    }
    if (service === 'overseerr') {
        try { await requestUserSync.syncOneCustomer(customerId); }
        catch (error) { console.warn('Overseerr resync after admin-authority change deferred:', safeLog(error.message)); }
    }
}

// Generalized service-scoped admin-authority actions ("give access", "remove
// a customer", "return to automatic management") for Jellyfin, Stremio and
// Overseerr from one place, backed by customer_service_admin_control.
// Server pinning stays on the existing Jellyfin-specific move/assign routes
// (admin-customer-operator.js), which now write through the same table.
function createAdminServiceAuthorityRouter() {
    const router = express.Router();
    router.use('/admin/users/:customerId/service-authority', gate, noStore, routeRateLimit.middleware({ scope: 'admin-service-authority', max: 60, windowSeconds: 60, reason: 'admin service authority change' }));

    router.post('/admin/users/:customerId/service-authority/:service/present', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await serviceAdminControl.setPresent(req.params.customerId, req.params.service, { actorUserId: req.session.authUserId, reason: req.body?.reason || '' });
            await resyncService(req.params.customerId, req.params.service);
            return res.redirect(customerPath(req.params.customerId, 'message', `${req.params.service} access granted by administrator.`));
        } catch (error) {
            return res.redirect(customerPath(req.params.customerId, 'error', String(error.message || 'Could not grant access.').slice(0, 300)));
        }
    });

    router.post('/admin/users/:customerId/service-authority/:service/removed', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await serviceAdminControl.setRemoved(req.params.customerId, req.params.service, { actorUserId: req.session.authUserId, reason: req.body?.reason || '' });
            await resyncService(req.params.customerId, req.params.service);
            return res.redirect(customerPath(req.params.customerId, 'message', `${req.params.service} access removed by administrator.`));
        } catch (error) {
            return res.redirect(customerPath(req.params.customerId, 'error', String(error.message || 'Could not remove access.').slice(0, 300)));
        }
    });

    router.post('/admin/users/:customerId/service-authority/:service/automatic', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            await serviceAdminControl.clear(req.params.customerId, req.params.service, { actorUserId: req.session.authUserId, reason: req.body?.reason || '' });
            await resyncService(req.params.customerId, req.params.service);
            return res.redirect(customerPath(req.params.customerId, 'message', `${req.params.service} returned to automatic management.`));
        } catch (error) {
            return res.redirect(customerPath(req.params.customerId, 'error', String(error.message || 'Could not return to automatic management.').slice(0, 300)));
        }
    });

    return router;
}

module.exports = { createAdminServiceAuthorityRouter };
