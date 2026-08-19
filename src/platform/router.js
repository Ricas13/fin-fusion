'use strict';

const express = require('express');
const core = require('./router-core');
const { createRuntimeLegacyRouter } = require('./router-runtime-legacy');
const placement = require('../jellyfin/placement');
const publicAbuseProtection = require('../security/public-abuse-protection');
const { createPublicHelpRouter } = require('./public-help');
const { createPublicPagesRouter } = require('./public-pages');
const { createAdminAutomationRouter } = require('./admin-automation');
const { createAdminSearchRouter } = require('./admin-search');
const { createAdminEventsRouter } = require('./admin-events');
const { createAdminCommerceRouter } = require('./admin-commerce');
const { createAdminPaymentReconciliationRouter } = require('./admin-payment-reconciliation');
const { createAdminStremioRouter } = require('./admin-stremio');
const { createAdminStremioSourcesRouter } = require('./admin-stremio-sources');
const { createAdminPlanDeliveryRouter } = require('./admin-plan-delivery');
const { createAdminPlanOrderRouter } = require('./admin-plan-order');
const { createAdminFleetOperationsRouter } = require('./admin-fleet-operations');
const { createAdminNotificationPreferencesRouter } = require('./admin-notification-preferences');
const { createAdminPersonalNotificationPreferencesRouter } = require('./admin-personal-notification-preferences-v2');
const { createAdminPersonalNotificationTestsRouter } = require('./admin-personal-notification-tests');
const { createAdminProfileAccountRouter } = require('./admin-profile-account');
const { createAdminAbuseProtectionRouter } = require('./admin-abuse-protection');
const { createAdminOperatorStateRouter } = require('./admin-operator-state');
const { createAdminJellyfinLifecycleRouter } = require('./admin-jellyfin-lifecycle');
const { createAdminCustomerJellyfinPasswordRouter } = require('./admin-customer-jellyfin-password');
const { createAccountActivationRouter } = require('./account-activation-router');
const { createCustomerPublicAuthRouter } = require('./customer-public-auth');
const { createCustomerLoginRouter } = require('./customer-login');
const { createCustomerHistoryRouter } = require('./customer-history');
const { createCustomerActivityRouter } = require('./customer-activity');
const { createCustomerSecurityRouter } = require('./customer-security');
const { createCustomerStremioRouter } = require('./customer-stremio');
const { createCustomerDashboardRouter } = require('./customer-dashboard');
const { createCustomerAffiliateRouter } = require('./customer-affiliate');
const { createCustomerCommunicationsRouter, createMessagingBotWebhookRouter } = require('./customer-communications');
const { createCustomerPaymentReturnRouter } = require('./customer-payment-return');
const { createCustomerPlanAcquisitionRouter } = require('./customer-plan-acquisition');

let fleetStarted = false;

function ensureFleetSnapshot() {
    if (!fleetStarted) {
        fleetStarted = true;
        placement.startFleetSnapshotRefresh();
    }
}

function onlyPathPrefix(prefix, childRouter) {
    const normalized = String(prefix || '').replace(/\/$/, '');
    return function pathScopedRouter(req, res, next) {
        const requestPath = req.path || '';
        if (requestPath !== normalized && !requestPath.startsWith(normalized + '/')) return next();
        return childRouter(req, res, next);
    };
}

function createRouter() {
    ensureFleetSnapshot();
    const router = express.Router();

    router.use(publicAbuseProtection.middleware);
    router.use(createMessagingBotWebhookRouter());
    router.use(createPublicPagesRouter());
    router.use(createPublicHelpRouter());
    router.use(createAccountActivationRouter());
    router.use(createCustomerPublicAuthRouter());
    router.use(createCustomerLoginRouter());
    router.use(createCustomerSecurityRouter());
    router.use(createCustomerCommunicationsRouter());
    router.use(createCustomerStremioRouter());
    router.use(createCustomerAffiliateRouter());
    router.use(createCustomerDashboardRouter());
    router.use(createAdminOperatorStateRouter());
    router.use(createAdminJellyfinLifecycleRouter());
    router.use(createAdminCustomerJellyfinPasswordRouter());
    router.use(createAdminAutomationRouter());
    router.use(createAdminSearchRouter());
    router.use(createAdminEventsRouter());
    router.get('/admin/configuration-health', (req, res) => res.redirect(302, '/admin/setup'));
    router.use(createAdminPaymentReconciliationRouter());
    router.use(createAdminCommerceRouter());
    router.use(createAdminStremioSourcesRouter());
    router.use(createAdminStremioRouter());
    router.use(createAdminPlanDeliveryRouter());
    router.use(createAdminPlanOrderRouter());
    router.use(createAdminFleetOperationsRouter());
    router.use(createAdminProfileAccountRouter());
    router.use(createAdminPersonalNotificationTestsRouter());
    router.use(createAdminPersonalNotificationPreferencesRouter());

    const globalNotificationRouter = createAdminNotificationPreferencesRouter();
    router.use(onlyPathPrefix('/admin/notifications/preferences', globalNotificationRouter));

    router.use(createAdminAbuseProtectionRouter());
    router.use(createCustomerActivityRouter());
    router.use(createCustomerHistoryRouter());
    router.use(createCustomerPaymentReturnRouter());
    router.use(createCustomerPlanAcquisitionRouter());

    router.use(createRuntimeLegacyRouter());
    return router;
}

module.exports = { ...core, createRouter, ensureFleetSnapshot, onlyPathPrefix };
