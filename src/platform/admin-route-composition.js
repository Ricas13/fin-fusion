'use strict';

const dashboard = require('./admin-dashboard');
const { createAdminAttentionRouter } = require('./admin-attention');
const { createAdminSetupRouter } = require('./admin-setup');
const { createAdminOperationsRouter } = require('./admin-operations');
const { createAdminBackupsRouter } = require('./admin-backups');
const { createAdminSupportPolicyRouter } = require('./admin-support-policy');
const { createAdminCatalogVersioningRouter } = require('./admin-catalog-versioning');
const { createAdminConfigurationTransferRouter } = require('./admin-configuration-transfer');
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
const { createAdminPaymentSettingsRouter } = require('./admin-payment-settings');
const { createAdminProviderMappingsRouter } = require('./admin-provider-mappings');
const { createAdminBillingRouter } = require('./admin-billing');
const { createAdminCustomerCreateRouter } = require('./admin-customer-create');
const { createAdminPlanCreateV2Router } = require('./admin-plan-create-v2');
const { createAdminPlanLifecycleRouter } = require('./admin-plan-lifecycle');
const { createAdminPlanInventoryRouter } = require('./admin-plan-inventory');
const { createAdminPlansListRouter } = require('./admin-plans-list');
const { createAdminPlanPaymentOptionsRouter } = require('./admin-plan-payment-options');
const { createAdminPlansRouter } = require('./admin-plans');
const { createAdminPlanPlacementFleetRouter } = require('./admin-plan-placement-fleet');
const { createAdminPlanPlacementRouter } = require('./admin-plan-placement');
const { createAdminJobsRouter } = require('./admin-jobs');
const { createAdminBulkCustomersRouter } = require('./admin-bulk-customers');
const { createAdminCustomersListRouter } = require('./admin-customers-list');
const { createAdminPlanLibrariesRouter } = require('./admin-plan-libraries');
const { createAdminServerFleetDashboardRouter } = require('./admin-server-fleet-dashboard');
const { createAdminServerLibraryDashboardRouter } = require('./admin-server-library-dashboard');
const { createAdminServersRouter } = require('./admin-servers');
const { createAdminActivityRouter } = require('./admin-activity');
const { createAdminLibrariesRouter } = require('./admin-libraries');
const { createAdminCustomer360Router } = require('./admin-customer-360');
const { createAdminUsersRouter } = require('./admin-users');
const { createAdminDiscountsRouter } = require('./admin-discounts');
const { createAdminReferralsRouter } = require('./admin-referrals');

/**
 * Mount the top-level admin routes in their canonical ownership order.
 *
 * Route order is intentionally explicit. Several admin endpoints have legacy
 * redirects or compatibility handlers, so changing this sequence is a
 * behaviour change and must be reviewed as such.
 */
function mountAdminRoutes(app) {
  app.get('/admin', dashboard.dashboardPage);
  app.use(createAdminAttentionRouter());
  app.use(createAdminSetupRouter());
  app.use(createAdminOperationsRouter());
  app.use(createAdminBackupsRouter());
  app.use(createAdminSupportPolicyRouter());
  app.use(createAdminCatalogVersioningRouter());
  app.use(createAdminConfigurationTransferRouter());
  app.use(createAdminOriginalSettingsRouter());
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
  app.use(createAdminPaymentSettingsRouter());
  app.use(createAdminProviderMappingsRouter());
  app.use(createAdminBillingRouter());
  app.use(createAdminCustomerCreateRouter());
  app.use(createAdminPlanCreateV2Router());
  app.use(createAdminPlanLifecycleRouter());
  app.use(createAdminPlanInventoryRouter());
  app.use(createAdminPlansListRouter());
  app.use(createAdminPlanPaymentOptionsRouter());
  app.use(createAdminPlansRouter());
  app.use(createAdminPlanPlacementFleetRouter());
  app.use(createAdminPlanPlacementRouter());
  app.use(createAdminJobsRouter());
  app.use(createAdminBulkCustomersRouter());
  app.use(createAdminCustomersListRouter());
  app.use(createAdminPlanLibrariesRouter());
  app.use(createAdminServerFleetDashboardRouter());
  app.use(createAdminServerLibraryDashboardRouter());
  app.use(createAdminServersRouter());
  app.use(createAdminActivityRouter());
  app.use(createAdminLibrariesRouter());
  app.use(createAdminCustomer360Router());
  app.use(createAdminUsersRouter());
  app.use(createAdminDiscountsRouter());
  app.use(createAdminReferralsRouter());
}

module.exports = { mountAdminRoutes };
