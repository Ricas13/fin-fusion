'use strict';

const express = require('express');
const core = require('./router-core');
const placement = require('../jellyfin/placement');
const lifecycle = require('../payments/lifecycle');
const publicAbuseProtection = require('../security/public-abuse-protection');
const routeRateLimit = require('../security/route-rate-limit');
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
const { createAdminFleetOperationsRouter } = require('./admin-fleet-operations');
const { createAdminNotificationPreferencesRouter } = require('./admin-notification-preferences');
const { createAdminPersonalNotificationPreferencesRouter } = require('./admin-personal-notification-preferences-v2');
const { createAdminPersonalNotificationTestsRouter } = require('./admin-personal-notification-tests');
const { createAdminProfileAccountRouter } = require('./admin-profile-account');
const { createAdminAbuseProtectionRouter } = require('./admin-abuse-protection');
const { createAdminOperatorStateRouter } = require('./admin-operator-state');
const { createAdminDashboardLayoutRouter } = require('./admin-dashboard-layout');
const { createAdminServersDashboardRouter } = require('./admin-servers-dashboard');
const { createAdminJellyfinLifecycleRouter } = require('./admin-jellyfin-lifecycle');
const { createAdminCustomerJellyfinPasswordRouter } = require('./admin-customer-jellyfin-password');
const { createAdminDocsRouter } = require('./admin-docs');
const { createAccountActivationRouter } = require('./account-activation-router');
const { createCustomerPublicAuthRouter } = require('./customer-public-auth');
const { createCustomerLoginRouter } = require('./customer-login');
const { createCustomerHistoryRouter } = require('./customer-history');
const { createCustomerActivityRouter } = require('./customer-activity');
const { createCustomerSecurityRouter } = require('./customer-security');
const { createCustomerStremioRouter } = require('./customer-stremio');
const { createCustomerAffiliateRouter } = require('./customer-affiliate');
const { createCustomerLibrarySelectionRouter } = require('./customer-library-selection');
const { createCustomerDashboardRouter } = require('./customer-dashboard');
const { createCustomerSupportRouter } = require('./customer-support');
const { createCustomerDocsRouter } = require('./customer-docs');
const { createCustomerCommunicationsRouter, createMessagingBotWebhookRouter } = require('./customer-communications');
const { createCustomerPaymentReturnRouter, mutationGuard } = require('./customer-payment-return');

const trialFreeLimit = routeRateLimit.middleware({ scope: 'customer-trial-free', max: 12, windowSeconds: 300 });
let fleetStarted = false;

function ensureFleetSnapshot() {
    if (!fleetStarted) {
        fleetStarted = true;
        placement.startFleetSnapshotRefresh();
    }
}

function requireCustomer(req, res, next) {
    return req.session?.customerId && req.session?.customerUserId
        ? next()
        : res.redirect('/account/login?next=' + encodeURIComponent(req.originalUrl || '/account'));
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
    router.use(createCustomerLibrarySelectionRouter());
    router.use(createCustomerDashboardRouter());
    router.use(createCustomerSupportRouter());
    router.use(createCustomerDocsRouter());
    router.use(createAdminOperatorStateRouter());
    router.use(createAdminDashboardLayoutRouter());
    router.use(createAdminServersDashboardRouter());
    router.use(createAdminJellyfinLifecycleRouter());
    router.use(createAdminCustomerJellyfinPasswordRouter());
    router.use(createAdminDocsRouter());
    router.use(createAdminAutomationRouter());
    router.use(createAdminSearchRouter());
    router.use(createAdminEventsRouter());
    router.get('/admin/configuration-health', (req, res) => res.redirect(302, '/admin/setup'));
    router.use(createAdminPaymentReconciliationRouter());
    router.use(createAdminCommerceRouter());
    router.use(createAdminStremioSourcesRouter());
    router.use(createAdminStremioRouter());
    router.use(createAdminPlanDeliveryRouter());
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

    router.post('/account/trial/start', trialFreeLimit, requireCustomer, mutationGuard, async (req, res) => {
        try {
            await lifecycle.startFreeTrial(req.session.customerId, req.body.planCode || null);
            return res.redirect('/account?welcome=1&message=' + encodeURIComponent('Your trial is active. Your access details are below.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    router.post('/account/claim-free/:planCode', trialFreeLimit, requireCustomer, mutationGuard, async (req, res) => {
        try {
            await lifecycle.claimFreePlan(req.session.customerId, req.params.planCode);
            return res.redirect('/account?welcome=1&message=' + encodeURIComponent('Free Access claimed. Your access details are below.'));
        } catch (error) {
            return res.redirect('/account?error=' + encodeURIComponent(error.message));
        }
    });

    return router;
}

module.exports = { ...core, createRouter, ensureFleetSnapshot, onlyPathPrefix };
