'use strict';

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
const { onlyPathPrefix } = require('./path-scoped-router');

function mountAdminRuntimeRoutes(router) {
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
}

module.exports = { mountAdminRuntimeRoutes };
