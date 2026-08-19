'use strict';

const express = require('express');
const planCreate = require('./admin-plan-create-v2');
const { customerCreate } = require('./admin-customer-create-form');

const BILLING_TERMS = {
    trial: { label: 'Trial', days: 1 },
    month: { label: 'Monthly', days: 30 },
    '6_months': { label: '6 months', days: 183 },
    year: { label: 'Yearly', days: 365 },
    custom: { label: 'Custom duration', days: null }
};
const CURRENCIES = ['GBP', 'USD', 'EUR'];
const SERVICE_TYPES = ['jellyfin', 'stremio', 'bundle'];

function planCreateInput(body = {}) {
    const input = { ...body };
    if (input.capacityLimit === undefined || input.capacityLimit === null || String(input.capacityLimit).trim() === '') input.capacityLimit = '0';
    if (input.streams === undefined || input.streams === null || String(input.streams).trim() === '') input.streams = '1';
    return planCreate.parse(input);
}

async function createPlanRecord(plan, actorUserId = null) {
    return planCreate.create(plan, actorUserId);
}

function planCreateForm(req, values = {}, error = '') {
    return planCreate.form(req, values, error);
}

function planCreateError(error) {
    if (error?.code === '23505') return 'That plan code already exists. Choose a different code.';
    if (error?.code === '23514' || error?.code === '22P02') return 'One of the plan values is outside the allowed range.';
    return error?.message || 'Plan could not be created safely. Check the values and try again.';
}

function createAdminCatalogShellRouter() {
    const router = express.Router();
    // Lazy-load the customer router because that historical module imports the
    // customerCreate compatibility export from this file.
    const { createAdminCustomerCreateRouter } = require('./admin-customer-create');
    router.use(createAdminCustomerCreateRouter());
    router.use(planCreate.createAdminPlanCreateV2Router());
    return router;
}

module.exports = {
    createAdminCatalogShellRouter,
    planCreateInput,
    createPlanRecord,
    planCreateError,
    planCreateForm,
    BILLING_TERMS,
    CURRENCIES,
    SERVICE_TYPES,
    customerCreate
};
