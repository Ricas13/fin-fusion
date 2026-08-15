'use strict';

const express = require('express');
const core = require('./router-core');
const placement = require('../jellyfin/placement');
const { createAdminAutomationRouter } = require('./admin-automation');
const { createAdminSearchRouter } = require('./admin-search');
const { createAdminEventsRouter } = require('./admin-events');

let fleetStarted = false;
function ensureFleetSnapshot() {
    if (fleetStarted) return;
    fleetStarted = true;
    placement.startFleetSnapshotRefresh();
}

function createRouter() {
    ensureFleetSnapshot();
    const router = express.Router();
    router.use(createAdminAutomationRouter());
    router.use(createAdminSearchRouter());
    router.use(createAdminEventsRouter());
    router.use(core.createRouter());
    return router;
}

module.exports = { ...core, createRouter, ensureFleetSnapshot };
