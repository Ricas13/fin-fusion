'use strict';

const routeRateLimit = require('../security/route-rate-limit');
const { ownerBoundary } = require('../auth/owner-guard');
const dashboard = require('./admin-dashboard');
require('./admin-commerce-expense-widgets');
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
const { createAdminDataExportRouter } = require('./admin-data-export');
const { createAdminLegacyCustomerImportRouter } = require('./admin-legacy-customer-import');
const { createAdminProviderMappingsRouter } = require('./admin-provider-mappings');
const { createAdminBillingRouter } = require('./admin-billing');
const { createAdminExpensesRouter } = require('./admin-expenses');
const { createAdminCustomerCreateRouter } = require('./admin-customer-create');
const { createAdminActionsRouter } = require('./admin-actions');
const { createAdminStremioPlanDispatchRouter } = require('./admin-stremio-plan-dispatch');
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
const { createAdminCustomerManagementRouter } = require('./admin-customer-management');
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
  app.use('/admin', adminMutationRateLimit);
  app.use('/admin', ownerBoundary);
  app.get('/admin', dashboard.dashboardPage);
  app.use(createAdminProductModulesRouter());
  app.use(createAdminAttentionRouter());
  // Literal customer overview routes must be mounted before any /admin/users/:id
  // owner so reserved page names such as "dashboard" can never be interpreted
  // as customer UUIDs by Customer 360 or legacy customer-management routes.
  app.use(createAdminUsersDashboardRouter());
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
  // Settings owns a stable Commerce directory. Mount it before the legacy
  // settings router so ?section=commerce no longer escapes into /admin/commerce.
  app.use(createAdminSettingsCommerceRouter());
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
  app.use(createAdminNotificationPreferencesRouter());
  app.use(createAdminPaymentSettingsRouter());
  app.use(createAdminTransactionsRouter());
  app.use(createAdminDataExportRouter());
  app.use(createAdminLegacyCustomerImportRouter());
  app.use(createAdminProviderMappingsRouter());
  app.use(createAdminBillingRouter());
  app.use(createAdminExpensesRouter());
  app.use(createAdminCustomerCreateRouter());
  // These three remaining administrative mutations used to arrive indirectly
  // through the runtime compatibility router. They are real admin routes, so
  // keep them in the canonical admin composition instead of a legacy tail.
  app.use(createAdminActionsRouter());
  // Stremio keeps its dedicated adaptive editor. Jellyfin/free plans are then
  // dispatched into the unified control room before legacy configuration
  // routes, which remain available as compatibility/save backstops.
  app.use(createAdminStremioPlanDispatchRouter());
  app.use(createAdminJellyfinPlanEditorRouter());
  app.use(createAdminPlanCreateV2Router());
  // Mount the access-driver editor before the legacy Plans controller so the
  // established /admin/plans/:id/jellyfin URL gains household-aware semantics
  // without duplicating or weakening the older plan-management routes.
  app.use(createAdminPlanAccessRouter());
  app.use(createAdminPlanInventoryRouter());
  app.use(createAdminPlansListRouter());
  app.use(createAdminPlanStreamVariantsRouter());
  app.use(createAdminPlanPaymentOptionsRouter());
  app.use(createAdminPlanOrderRouter());
  app.use(createAdminPlansRouter());
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
  app.use(createAdminCustomerManagementRouter());
  // These middleware-owning routers must precede Customer 360. They wrap the
  // canonical page response and own the lane-scoped mutation paths before the
  // legacy customer-wide handlers can match them. Impersonation's own
  // audit/banner catch-all middleware is mounted separately, much earlier in
  // application.js (before every /account router) -- see the comment there.
  // This router (the impersonate/exit routes plus the Customer 360
  // button-injection middleware) stays here, after the more specific
  // /admin/users/dashboard route above, so its /admin/users/:customerId
  // wildcard never shadows it.
  app.use(createAdminImpersonationRouter());
  app.use(createAdminLanePolicyRouter());
  app.use(createAdminCustomer360Router());
  app.use(createAdminUsersRouter());
  app.use(createAdminDiscountsRouter());
  app.use(createAdminReferralsRouter());
  app.use(createAdminMarketingRouter());
}

module.exports = { mountAdminRoutes, adminMutationRateLimit };
