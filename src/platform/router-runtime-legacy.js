'use strict';

const express = require('express');
const { createAdminActionsRouter } = require('./admin-actions');
const { createCustomerLibrarySelectionRouter } = require('./customer-library-selection');
const { createCustomerRequestPasswordRouter } = require('./customer-request-password');
const { createPublicPlanApiRouter } = require('./public-plan-api');
const { requireCustomer } = require('./customer-session-guard');
const runtimeSettings = require('./runtime-settings');

function createRuntimeLegacyRouter() {
    const router = express.Router();

    // Compatibility composition only. Business handlers live in their explicit
    // route modules; this wrapper preserves historical construction/error APIs.
    router.use(createAdminActionsRouter());
    router.use(createCustomerLibrarySelectionRouter());
    router.use(createCustomerRequestPasswordRouter());
    router.use(createPublicPlanApiRouter());

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
