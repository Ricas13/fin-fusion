'use strict';

const express = require('express');
const core = require('./router-core');
const placement = require('../jellyfin/placement');
const { createAdminAutomationRouter } = require('./admin-automation');
const { createAdminSearchRouter } = require('./admin-search');
const { createAdminEventsRouter } = require('./admin-events');
const { createAccountActivationRouter } = require('./account-activation-router');

let fleetStarted = false;
function ensureFleetSnapshot() {
    if (fleetStarted) return;
    fleetStarted = true;
    placement.startFleetSnapshotRefresh();
}

function createRouter() {
    ensureFleetSnapshot();
    const router = express.Router();
    router.use(createAccountActivationRouter());
    router.use(createAdminAutomationRouter());
    router.use(createAdminSearchRouter());
    router.use(createAdminEventsRouter());
    router.use(core.createRouter());
    return router;
}

module.exports = { ...core, createRouter, ensureFleetSnapshot };
