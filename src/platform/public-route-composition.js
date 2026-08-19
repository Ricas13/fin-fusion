'use strict';

const publicAbuseProtection = require('../security/public-abuse-protection');
const { createMessagingBotWebhookRouter } = require('./customer-communications');
const { createPublicPagesRouter } = require('./public-pages');
const { createPublicHelpRouter } = require('./public-help');
const { createAccountActivationRouter } = require('./account-activation-router');
const { createCustomerPublicAuthRouter } = require('./customer-public-auth');
const { createCustomerLoginRouter } = require('./customer-login');

function mountPublicRoutes(router) {
    router.use(publicAbuseProtection.middleware);
    router.use(createMessagingBotWebhookRouter());
    router.use(createPublicPagesRouter());
    router.use(createPublicHelpRouter());
    router.use(createAccountActivationRouter());
    router.use(createCustomerPublicAuthRouter());
    router.use(createCustomerLoginRouter());
}

module.exports = { mountPublicRoutes };
