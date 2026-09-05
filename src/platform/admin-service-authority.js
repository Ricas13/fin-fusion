'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { query } = require('../db');
const routeRateLimit = require('../security/route-rate-limit');
const serviceAdminControl = require('../entitlements/service-admin-control');
const permanentAccess = require('../entitlements/permanent-access');
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
    return JSON.stringify(String(value == null ? '' : value).slice(0, max));
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

async function returnToNormalAutomation(customerId, { actorUserId = null } = {}) {
    const reason = 'Returned customer to normal automation';
    const permanent = await permanentAccess.revoke(customerId, { actorUserId, reason });
    const services = {};
    for (const service of ['jellyfin', 'stremio', 'overseerr']) {
        services[service] = await serviceAdminControl.clear(customerId, service, { actorUserId, reason });
    }
    await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
                 VALUES($1,'admin.customer.return_to_normal_automation','customer',$2,$3::jsonb)`, [
        actorUserId,
        customerId,
        JSON.stringify({
            permanentAccessRevoked: Boolean(permanent.changed),
            serviceOverridesCleared: Object.fromEntries(Object.entries(services).map(([service, result]) => [service, Boolean(result.changed)])),
            providerBillingChanged: false
        })
    ]);

    const warnings = [];
    try { await provisioning.reconcileCustomer(customerId); }
    catch (error) { warnings.push(`media: ${String(error.message || error).slice(0, 180)}`); }
    try { await requestUserSync.syncOneCustomer(customerId); }
    catch (error) { warnings.push(`request service: ${String(error.message || error).slice(0, 180)}`); }
    return { permanent, services, warnings };
}

function createAdminServiceAuthorityRouter() {
    const router = express.Router();
    router.use('/admin/users/:customerId/service-authority', gate, noStore, routeRateLimit.middleware({ scope: 'admin-service-authority', max: 60, windowSeconds: 60, reason: 'admin service authority change' }));
    router.use('/admin/users/:customerId/manage/normal-automation', gate, noStore, routeRateLimit.middleware({ scope: 'admin-normal-automation', max: 20, windowSeconds: 60, reason: 'admin return to normal automation' }));

    router.post('/admin/users/:customerId/manage/normal-automation', async (req, res) => {
        if (!csrf.verify(req)) return res.status(403).send('Invalid or expired security token');
        try {
            const result = await returnToNormalAutomation(req.params.customerId, { actorUserId: req.session.authUserId });
            if (result.warnings.length) return res.redirect(customerPath(req.params.customerId, 'error', `Returned to normal automation, but reconciliation needs attention: ${result.warnings.join(' · ')}`));
            return res.redirect(customerPath(req.params.customerId, 'message', 'Returned to normal automation. Valid plans were kept; permanent access, admin service overrides and server pinning were removed.'));
        } catch (error) {
            return res.redirect(customerPath(req.params.customerId, 'error', String(error.message || 'Could not return to normal automation.').slice(0, 300)));
        }
    });

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

module.exports = { createAdminServiceAuthorityRouter, returnToNormalAutomation };