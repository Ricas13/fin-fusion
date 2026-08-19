'use strict';

const express = require('express');
const customers = require('../customers');

function createPublicPlanApiRouter() {
    const router = express.Router();

    router.get('/api/platform/plans', async (_req, res, next) => {
        try { return res.json(await customers.listPublicPlans()); }
        catch (error) { return next(error); }
    });

    return router;
}

module.exports = { createPublicPlanApiRouter };
