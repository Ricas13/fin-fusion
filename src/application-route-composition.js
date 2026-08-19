'use strict';

const firstRun = require('./auth/first-run-setup');
const controller = require('./auth/staff-controller');
const runtimeSettings = require('./platform/runtime-settings');
const { createFirstRunRouter } = require('./auth/first-run-controller');
const { createAdminSecurityRouter } = require('./platform/admin-security');
const { storefrontPage } = require('./platform/storefront');
const { createBrandingRouter } = require('./platform/branding');
const { createCustomerClaimRouter } = require('./platform/customer-claim');
const { createCustomerPasswordSyncRouter } = require('./platform/customer-password-sync');
const { createCustomerSubscriptionActionsRouter } = require('./platform/customer-subscription-actions');
const { createFlexibleCheckoutRouter } = require('./platform/flexible-checkout');
const { createAdminPreviewRouter } = require('./platform/admin-preview');
const { mountAdminRoutes } = require('./platform/admin-route-composition');
const { createRouter } = require('./platform/router');

async function loginSetupGate(req, res, next) {
  try {
    if (await firstRun.isSetupRequired()) return res.redirect('/setup');
    await runtimeSettings.ensureLoaded().catch(() => {});
    return next();
  } catch (error) {
    return next(error);
  }
}

function mountApplicationRoutes(app) {
  app.use(createFirstRunRouter());
  app.get('/login', loginSetupGate, controller.loginPage);
  app.post('/login', loginSetupGate, controller.loginSubmit);
  app.get('/logout', controller.logout);
  app.use(controller.createAuthRouter());
  app.use(createAdminSecurityRouter());

  app.get('/', async (req, res, next) => {
    try {
      if (await firstRun.isSetupRequired()) return res.redirect('/setup');
      return storefrontPage(req, res, next);
    } catch (error) {
      return next(error);
    }
  });

  app.use(createBrandingRouter());
  app.use(createCustomerClaimRouter());
  app.use(createCustomerPasswordSyncRouter());
  app.use(createCustomerSubscriptionActionsRouter());
  app.use(createFlexibleCheckoutRouter());
  app.use(createAdminPreviewRouter());

  app.use('/invite', (_req, res) => res.status(410).send('Invitation onboarding is no longer available.'));
  app.use('/admin/invitations', (_req, res) => res.redirect(
    302,
    '/admin/users?message=' + encodeURIComponent('Invitations are retired. Add or import customers instead.')
  ));

  mountAdminRoutes(app);
  app.use(createRouter());
}

module.exports = { mountApplicationRoutes, loginSetupGate };
