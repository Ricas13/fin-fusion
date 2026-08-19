'use strict';

const express = require('express');
const lifecycle = require('../payments/lifecycle');
const routeRateLimit = require('../security/route-rate-limit');
const { mutationGuard } = require('./customer-payment-return');
const { requireCustomer } = require('./customer-session-guard');

const trialFreeLimit = routeRateLimit.middleware({
    scope: 'customer-trial-free',
    max: 12,
    windowSeconds: 300
});

function createCustomerPlanAcquisitionRouter() {
    const router = express.Router();

    router.post('/account/trial/start', trialFreeLimit, requireCustomer, mutationGuard, async (req, res) => {
        try {
            await lifecycle.startFreeTrial(req.session.customerId, req.body.planCode || null);
            return res.redirect('/account?welcome=1&message=' + encodeURIComponent('Your trial is active. Your access details are below.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/account/claim-free/:planCode', trialFreeLimit, requireCustomer, mutationGuard, async (req, res) => {
        try {
            await lifecycle.claimFreePlan(req.session.customerId, req.params.planCode);
            return res.redirect('/account?welcome=1&message=' + encodeURIComponent('Free Access claimed. Your access details are below.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    return router;
}

module.exports = {
    createCustomerPlanAcquisitionRouter,
    trialFreeLimit
};
