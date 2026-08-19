'use strict';

const express = require('express');
const requestUserSync = require('../integrations/request-user-sync');
const csrf = require('../auth/csrf');
const { requireCustomer } = require('./customer-session-guard');

function createCustomerRequestPasswordRouter() {
    const router = express.Router();

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

    return router;
}

module.exports = { createCustomerRequestPasswordRouter };
