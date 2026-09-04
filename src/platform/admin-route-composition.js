'use strict';

const routeRateLimit = require('../security/route-rate-limit');
const { ownerBoundary } = require('../auth/owner-guard');
const dashboard = require('./admin-dashboard');
require('./admin-commerce-expense-widgets');
const { assertAdminRouteOrder } = require('./admin-route-manifest');
const { createAdminProductModulesRouter } = require('./admin-product-modules');
const { createAdminAttentionRouter } = require('./admin-attention');
const { createAdminSupportTicketsRouter } = require('./admin-support-tickets');
const { createAdminOrdersRouter } = require('./admin-orders');
const { createAdminSetupRouter } = require('./admin-setup');
const { createAdminSystemRouter } = require('./admin-system');
const { createAdminOperationsRouter } = require('./admin-operations');
const { createAdminBackupsRouter } = require('./admin-backups');
const { createAdminSupportPolicyRouter } = require('./admin-support-policy');
const { createAdminCatalogVersioningRouter } = require('./admin-catalog-versioning');
const { createAdminConfigurationTransferRouter } = require('./admin-configuration-transfer');
const { createAdminCurrencySettingsRouter } = require('./admin-currency-settings');
const { createAdminIntegrationsOverviewRouter } = require('./admin-integrations-overview');
const { createAdminSettingsCommerceRouter } = require('./admin-settings-commerce');
const { createAdminOriginalSettingsRouter } = require('./admin-original-settings');
const { createAdminBrandingRouter } = require('./admin-branding');
const { createAdminCommercialPoliciesRouter } = require('./admin-commercial-policies');
const { createAdminServerUsersRouter, createLegacyJellyfinImportRedirectRouter } = require('./admin-server-users');
const { createAdminServerMigrationsRouter } = require('./admin-server-migrations');
const { createAdminRequestPlanPolicyRouter } = require('./admin-request-plan-policy');
const { createAdminRequestUsersRouter } = require('./admin-request-users');
const { createAdminRequestRedirectRouter } = require('./admin-request-redirect');
const { createAdminProvisioningRouter } = require('./admin-provisioning');
const { createAdminDriftRouter } = require('./admin-drift');
const { createAdminEmailRouter } = require('./admin-email');
const { createAdminNotificationPreferencesRouter } = require('./admin-notification-preferences');
const { createAdminPaymentSettingsRouter } = require('./admin-payment-settings');
const { createAdminTransactionsRouter } = require('./admin-transactions');
const { createAdminProrataRefundsRouter } = require('./admin-prorata-refunds');
const { createAdminDataExportRouter } = require('./admin-data-export');
const { createAdminLegacyCustomerImportRouter } = require('./admin-legacy-customer-import');
const { createAdminProviderMappingsRouter } = require('./admin-provider-mappings');
const { createAdminBillingRouter } = require('./admin-billing');
const { createAdminExpensesRouter } = require('./admin-expenses');
const { createAdminCustomerCreateRouter } = require('./admin-customer-create');
const { createAdminActionsRouter } = require('./admin-actions');
const { createAdminMediaControlsRouter } = require('./admin-media-controls');
const { createAdminDashboardLiveStreamsRouter } = require('./admin-dashboard-live-streams');
const { createAdminStremioPlanDispatchRouter } = require('./admin-stremio-plan-dispatch');
const { createAdminEmbyPlanEditorRouter } = require('./admin-emby-plan-editor');
const { createAdminJellyfinPlanEditorRouter } = require('./admin-jellyfin-plan-editor');
const { createAdminPlanCreateV2Router } = require('./admin-plan-create-v2');
const { createAdminPlanAccessRouter } = require('./admin-plan-access');
const { createAdminPlanInventoryRouter } = require('./admin-plan-inventory');
const { createAdminPlansListRouter } = require('./admin-plans-list');
const { createAdminPlanStreamVariantsRouter } = require('./admin-plan-stream-variants');
const { createAdminPlanPaymentOptionsRouter } = require('./admin-plan-payment-options');
const { createAdminPlanOrderRouter } = require('./admin-plan-order');
const { createAdminPlansRouter } = require('./admin-plans');
const { createAdminPlanPlacementFleetRouter } = require('./admin-plan-placement-fleet');
const { createAdminPlanPlacementRouter } = require('./admin-plan-placement');
const { createAdminJobsRouter } = require('./admin-jobs');
const { createAdminBulkCustomersRouter } = require('./admin-bulk-customers');
const { createAdminCustomersListRouter } = require('./admin-customers-list');
const { createAdminPlanLibrariesRouter } = require('./admin-plan-libraries');
const { createAdminServerFleetDashboardRouter } = require('./admin-server-fleet-dashboard');
const { createAdminServerLibraryDashboardRouter } = require('./admin-server-library-dashboard');
const { createAdminStremioManagedSourcesRouter } = require('./admin-stremio-managed-sources');
const { createAdminServersRouter } = require('./admin-servers');
const { createAdminActivityRouter } = require('./admin-activity');
const { createAdminLibrariesRouter } = require('./admin-libraries');
const { createAdminCustomerAccessHoldsRouter } = require('./admin-customer-access-holds');
const { createAdminCustomerManagementRouter } = require('./admin-customer-management');
const { createAdminCustomerOperatorRouter } = require('./admin-customer-operator');
const { createAdminJellyfinReenableRouter } = require('./admin-jellyfin-reenable');
const { createAdminManualEntitlementRouter } = require('./admin-manual-entitlement');
const { createAdminImpersonationRouter } = require('./admin-impersonation');
const { createAdminLanePolicyRouter } = require('./admin-lane-policy');
const { createAdminCustomer360Router } = require('./admin-customer-360');
const { createAdminUsersDashboardRouter } = require('./admin-users-dashboard');
const { createAdminUsersRouter } = require('./admin-users');
const { createAdminDiscountsRouter } = require('./admin-discounts');
const { createAdminReferralsRouter } = require('./admin-referrals');
const { createAdminMarketingRouter } = require('./admin-marketing');

const adminMutationLimit = routeRateLimit.middleware({
  scope: 'admin-mutation',
  max: 300,
  windowSeconds: 60,
  reason: 'admin_mutation'
});

function adminMutationRateLimit(req, res, next) {
  if (req.method !== 'POST') return next();
  if (!(req.session?.authUserId && req.session?.authRole === 'admin')) return next();
  return adminMutationLimit(req, res, next);
}

function mountAdminRoutes(app) {
  const criticalOrder = [];
  const mountCritical = (name, router) => {
    criticalOrder.push(name);
    app.use(router);
  };

  app.use('/admin', adminMutationRateLimit);
  app.use('/admin', ownerBoundary);
  app.get('/admin', dashboard.dashboardPage);
  app.use(createAdminProductModulesRouter());
  app.use(createAdminAttentionRouter());

  mountCritical('usersDashboard', createAdminUsersDashboardRouter());
  app.use(createAdminSupportTicketsRouter());
  app.use(createAdminOrdersRouter());
  app.use(createAdminSetupRouter());
  app.use(createAdminSystemRouter());
  app.use(createAdminOperationsRouter());
  app.use(createAdminBackupsRouter());
  app.use(createAdminSupportPolicyRouter());
  app.use(createAdminCatalogVersioningRouter());
  app.use(createAdminConfigurationTransferRouter());
  app.use(createAdminCurrencySettingsRouter());
  app.use(createAdminIntegrationsOverviewRouter());

  mountCritical('settingsCommerce', createAdminSettingsCommerceRouter());
  mountCritical('originalSettings', createAdminOriginalSettingsRouter());
  app.use(createAdminBrandingRouter());
  app.use(createAdminCommercialPoliciesRouter());
  app.use(createAdminServerUsersRouter());
  app.use(createLegacyJellyfinImportRedirectRouter());
  app.use(createAdminServerMigrationsRouter());
  app.use(createAdminRequestPlanPolicyRouter());
  app.use(createAdminRequestUsersRouter());
  app.use(createAdminRequestRedirectRouter());
  app.use(createAdminProvisioningRouter());
  app.use(createAdminDriftRouter());
  app.use(createAdminEmailRouter());
  app.use(createAdminNotificationPreferencesRouter());
  app.use(createAdminPaymentSettingsRouter());
  app.use(createAdminTransactionsRouter());
  app.use(createAdminProrataRefundsRouter());
  app.use(createAdminDataExportRouter());
  app.use(createAdminLegacyCustomerImportRouter());
  app.use(createAdminProviderMappingsRouter());
  app.use(createAdminBillingRouter());
  app.use(createAdminExpensesRouter());
  app.use(createAdminCustomerCreateRouter());
  app.use(createAdminActionsRouter());
  app.use(createAdminMediaControlsRouter());
  app.use(createAdminDashboardLiveStreamsRouter());
  app.use(createAdminStremioPlanDispatchRouter());
  app.use(createAdminEmbyPlanEditorRouter());
  app.use(createAdminJellyfinPlanEditorRouter());
  app.use(createAdminPlanCreateV2Router());

  mountCritical('planAccess', createAdminPlanAccessRouter());
  app.use(createAdminPlanInventoryRouter());
  app.use(createAdminPlansListRouter());
  app.use(createAdminPlanStreamVariantsRouter());
  app.use(createAdminPlanPaymentOptionsRouter());
  app.use(createAdminPlanOrderRouter());
  mountCritical('plans', createAdminPlansRouter());
  app.use(createAdminPlanPlacementFleetRouter());
  app.use(createAdminPlanPlacementRouter());
  app.use(createAdminJobsRouter());
  app.use(createAdminBulkCustomersRouter());
  app.use(createAdminCustomersListRouter());
  app.use(createAdminPlanLibrariesRouter());
  app.use(createAdminServerFleetDashboardRouter());
  app.use(createAdminServerLibraryDashboardRouter());
  app.use(createAdminStremioManagedSourcesRouter());
  app.use(createAdminServersRouter());
  app.use(createAdminActivityRouter());
  app.use(createAdminLibrariesRouter());
  app.use(createAdminJellyfinReenableRouter());
  app.use(createAdminCustomerAccessHoldsRouter());
  app.use(createAdminCustomerManagementRouter());
  app.use(createAdminCustomerOperatorRouter());
  app.use(createAdminManualEntitlementRouter());

  mountCritical('impersonation', createAdminImpersonationRouter());
  mountCritical('lanePolicy', createAdminLanePolicyRouter());
  mountCritical('customer360', createAdminCustomer360Router());
  app.use(createAdminUsersRouter());
  app.use(createAdminDiscountsRouter());
  app.use(createAdminReferralsRouter());
  app.use(createAdminMarketingRouter());

  assertAdminRouteOrder(criticalOrder);
}

module.exports = { mountAdminRoutes, adminMutationRateLimit };
