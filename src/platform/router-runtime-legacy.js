'use strict';

const express = require('express');
const customers = require('../customers');
const provisioning = require('../jellyfin/resilient-provisioning');
const requestUserSync = require('../integrations/request-user-sync');
const policy = require('../jellyfin/policy');
const csrf = require('../auth/csrf');
const { createAdminActionsRouter } = require('./admin-actions');
const runtimeSettings = require('./runtime-settings');

function requireCustomer(req, res, next) {
    if (req.session?.customerId && req.session?.customerUserId) return next();
    return res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
}

function createRuntimeLegacyRouter() {
    const router = express.Router();

    // These admin actions are still canonical and were previously inherited
    // by mounting router-core after its obsolete routes were pruned.
    router.use(createAdminActionsRouter());

    router.post('/account/libraries', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.redirect('/account?error=' + encodeURIComponent('Invalid or expired security token'));
        try {
            const plan = await provisioning.currentEntitlement(req.session.customerId);
            const effective = await provisioning.effectivePolicyForCustomer(req.session.customerId, plan);
            const submitted = Array.isArray(req.body.library)
                ? req.body.library
                : (req.body.library !== undefined ? [req.body.library] : []);
            const chosen = [];
            for (const raw of submitted) {
                const name = String(raw || '').trim();
                if (!name) continue;
                const match = effective.entitlementRows.find(
                    row => row.effective && policy.nameKey(row.name) === policy.nameKey(name)
                );
                if (match) chosen.push(match.name);
            }
            await provisioning.setLibrarySelection(req.session.customerId, chosen);
            try { await provisioning.reconcileCustomer(req.session.customerId); } catch (_) {}
            return res.redirect('/account?message=' + encodeURIComponent('Library visibility updated.'));
        } catch (_) {
            return res.redirect('/account?error=' + encodeURIComponent('Library visibility could not be updated safely.'));
        }
    });

    router.post('/account/requests/password', requireCustomer, async (req, res) => {
        if (!csrf.verify(req)) return res.redirect('/account?error=' + encodeURIComponent('Invalid or expired security token'));
        try {
            if (req.body.password !== req.body.confirmPassword) throw new Error('Request-site passwords do not match.');
            await requestUserSync.setCustomerPassword(req.session.customerId, req.body.password);
            return res.redirect('/account?message=' + encodeURIComponent('Request-site password updated.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message || 'Request-site password could not be updated.'));
        }
    });

    router.get('/api/platform/plans', async (_req, res, next) => {
        try { return res.json(await customers.listPublicPlans()); }
        catch (error) { return next(error); }
    });

    router.use((error, req, res, _next) => {
        console.error('Platform route error:', error);
        if (req.path.startsWith('/api/')) return res.status(500).json({ success: false, error: 'Internal server error' });
        return res.status(500).render('customer/message', {
            title: 'Something went wrong',
            message: 'The request could not be completed. Please try again.',
            siteName: runtimeSettings.siteName()
        });
    });

    return router;
}

module.exports = { createRuntimeLegacyRouter, requireCustomer };
