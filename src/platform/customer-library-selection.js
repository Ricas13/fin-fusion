'use strict';

const express = require('express');
const provisioning = require('../jellyfin/resilient-provisioning');
const policy = require('../jellyfin/policy');
const csrf = require('../auth/csrf');
const { requireCustomer } = require('./customer-session-guard');

function createCustomerLibrarySelectionRouter() {
    const router = express.Router();

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

    return router;
}

module.exports = { createCustomerLibrarySelectionRouter };
