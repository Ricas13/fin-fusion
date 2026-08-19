'use strict';

const express = require('express');
const core = require('./router-core');
const { createRuntimeLegacyRouter } = require('./router-runtime-legacy');
const { mountPublicRoutes } = require('./public-route-composition');
const { mountCustomerAccountRoutes, mountCustomerActionRoutes } = require('./customer-route-composition');
const { mountAdminRuntimeRoutes } = require('./admin-runtime-route-composition');
const { onlyPathPrefix } = require('./path-scoped-router');
const placement = require('../jellyfin/placement');

let fleetStarted = false;

function ensureFleetSnapshot() {
    if (!fleetStarted) {
        fleetStarted = true;
        placement.startFleetSnapshotRefresh();
    }
}

function createRouter() {
    ensureFleetSnapshot();
    const router = express.Router();

    // Preserve the established precedence exactly: public entrypoints, the
    // primary customer account surface, admin runtime routes, then customer
    // action/history routes and finally compatibility composition.
    mountPublicRoutes(router);
    mountCustomerAccountRoutes(router);
    mountAdminRuntimeRoutes(router);
    mountCustomerActionRoutes(router);
    router.use(createRuntimeLegacyRouter());

    return router;
}

module.exports = { ...core, createRouter, ensureFleetSnapshot, onlyPathPrefix };
