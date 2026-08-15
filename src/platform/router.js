'use strict';

const express = require('express');
const core = require('./router-core');
const placement = require('../jellyfin/placement');
const publicAbuseProtection = require('../security/public-abuse-protection');
const { createPublicHelpRouter } = require('./public-help');
const { createAdminAutomationRouter } = require('./admin-automation');
const { createAdminSearchRouter } = require('./admin-search');
const { createAdminEventsRouter } = require('./admin-events');
const { createAdminCommerceRouter } = require('./admin-commerce');
const { createAdminPaymentReconciliationRouter } = require('./admin-payment-reconciliation');
const { createAdminResellerSettingsRouter } = require('./admin-reseller-settings');
const { createAdminResellerDunningRouter } = require('./admin-reseller-dunning');
const { createAdminNotificationPreferencesRouter } = require('./admin-notification-preferences');
const { createAdminAbuseProtectionRouter } = require('./admin-abuse-protection');
const { createAccountActivationRouter } = require('./account-activation-router');
const { createResellerSecurityRouter } = require('./reseller-security');
const { createResellerLedgerRouter } = require('./reseller-ledger');
const { createResellerExportRouter } = require('./reseller-export');
const { createCustomerPublicAuthRouter } = require('./customer-public-auth');
const { createCustomerLoginRouter } = require('./customer-login');
const { createCustomerHistoryRouter } = require('./customer-history');
const { createCustomerSecurityRouter } = require('./customer-security');
const { createCustomerPaymentReturnRouter, mutationGuard } = require('./customer-payment-return');

let fleetStarted=false;
function ensureFleetSnapshot(){if(!fleetStarted){fleetStarted=true;placement.startFleetSnapshotRefresh();}}
function pruneRoutes(router,paths){if(!router?.stack)return router;router.stack=router.stack.filter(layer=>{if(layer.route&&paths.has(String(layer.route.path)))return false;if(layer.handle?.stack)pruneRoutes(layer.handle,paths);return true;});return router;}
function createRouter(){
    ensureFleetSnapshot();const router=express.Router();
    router.use(publicAbuseProtection.middleware);
    router.use(createPublicHelpRouter());
    router.use(createAccountActivationRouter());
    router.use(createCustomerPublicAuthRouter());
    router.use(createCustomerLoginRouter());
    router.use(createCustomerSecurityRouter());
    router.use(createResellerSecurityRouter());
    router.get('/reseller/sales',(req,res)=>res.redirect(302,'/reseller/ledger'));
    router.use(createResellerLedgerRouter());
    router.use(createResellerExportRouter());
    router.use(createAdminAutomationRouter());
    router.use(createAdminSearchRouter());
    router.use(createAdminEventsRouter());
    router.get('/admin/configuration-health',(req,res)=>res.redirect(302,'/admin/setup'));
    router.use(createAdminPaymentReconciliationRouter());
    router.use(createAdminCommerceRouter());
    router.use(createAdminResellerSettingsRouter());
    router.use(createAdminResellerDunningRouter());
    router.use(createAdminNotificationPreferencesRouter());
    router.use(createAdminAbuseProtectionRouter());
    router.use(createCustomerHistoryRouter());
    router.use(createCustomerPaymentReturnRouter());
    router.use('/account',(req,res,next)=>req.method==='POST'&&req.session?.customerId&&req.session?.customerUserId?mutationGuard(req,res,next):next());
    const legacy=core.createRouter();
    pruneRoutes(legacy,new Set([
        '/account/register','/account/verify-email','/account/forgot-password','/account/reset-password',
        '/account/login','/account/logout','/account/checkout/stripe','/account/checkout/paypal','/account/paypal/return','/account/stripe/portal',
        '/account/jellyfin/:accountId/password',
        '/admin/configuration','/admin/configuration/export','/admin/configuration/preview','/admin/configuration/apply','/admin/notifications/preferences',
        '/admin/plans/:id/commerce','/admin/plans/:id/provider'
    ]));
    router.use(legacy);return router;
}
module.exports={...core,createRouter,ensureFleetSnapshot,pruneRoutes};
