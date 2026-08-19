'use strict';

const { createCustomerSecurityRouter } = require('./customer-security');
const { createCustomerCommunicationsRouter } = require('./customer-communications');
const { createCustomerStremioRouter } = require('./customer-stremio');
const { createCustomerAffiliateRouter } = require('./customer-affiliate');
const { createCustomerDashboardRouter } = require('./customer-dashboard');
const { createCustomerActivityRouter } = require('./customer-activity');
const { createCustomerHistoryRouter } = require('./customer-history');
const { createCustomerPaymentReturnRouter } = require('./customer-payment-return');
const { createCustomerPlanAcquisitionRouter } = require('./customer-plan-acquisition');

function mountCustomerAccountRoutes(router) {
    router.use(createCustomerSecurityRouter());
    router.use(createCustomerCommunicationsRouter());
    router.use(createCustomerStremioRouter());
    router.use(createCustomerAffiliateRouter());
    router.use(createCustomerDashboardRouter());
}

function mountCustomerActionRoutes(router) {
    router.use(createCustomerActivityRouter());
    router.use(createCustomerHistoryRouter());
    router.use(createCustomerPaymentReturnRouter());
    router.use(createCustomerPlanAcquisitionRouter());
}

module.exports = { mountCustomerAccountRoutes, mountCustomerActionRoutes };
