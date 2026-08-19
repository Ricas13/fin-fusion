'use strict';

const express = require('express');
const { createAdminRequestActionsRouter } = require('./admin-request-actions');
const { createAdminStorefrontSettingsActionsRouter } = require('./admin-storefront-settings-actions');

function createAdminActionsRouter() {
    const router = express.Router();
    router.use(createAdminRequestActionsRouter());
    router.use(createAdminStorefrontSettingsActionsRouter());
    return router;
}

module.exports = { createAdminActionsRouter };
