'use strict';

const express = require('express');
const core = require('./router-core');
const placement = require('../jellyfin/placement');
const lifecycle = require('../payments/lifecycle');
const publicAbuseProtection = require('../security/public-abuse-protection');
const routeRateLimit = require('../security/route-rate-limit');
const { createPublicHelpRouter } = require('./public-help');
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
const { createCustomerSecurityRouter } = require('./customer-security');
const { createCustomerStremioRouter } = require('./customer-stremio');
const { createCustomerDashboardRouter } = require('./customer-dashboard');
const { createCustomerAffiliateRouter } = require('./customer-affiliate');
const { createCustomerCommunicationsRouter,createMessagingBotWebhookRouter } = require('./customer-communications');
const { createCustomerPaymentReturnRouter, mutationGuard } = require('./customer-payment-return');

const trialFreeLimit=routeRateLimit.middleware({scope:'customer-trial-free',max:12,windowSeconds:300});
let fleetStarted=false;
function ensureFleetSnapshot(){if(!fleetStarted){fleetStarted=true;placement.startFleetSnapshotRefresh();}}
function requireCustomer(req,res,next){return req.session?.customerId&&req.session?.customerUserId?next():res.redirect('/account/login?next='+encodeURIComponent(req.originalUrl||'/account'));}
function pruneRoutes(router,paths){if(!router?.stack)return router;router.stack=router.stack.filter(layer=>{if(layer.route&&paths.has(String(layer.route.path)))return false;if(layer.handle?.stack)pruneRoutes(layer.handle,paths);return true;});return router;}
function createRouter(){
    ensureFleetSnapshot();const router=express.Router();
    router.use(publicAbuseProtection.middleware);
    router.use(createMessagingBotWebhookRouter());
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
    router.get('/admin/configuration-health',(req,res)=>res.redirect(302,'/admin/setup'));
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
    const globalNotificationRouter=createAdminNotificationPreferencesRouter();
    pruneRoutes(globalNotificationRouter,new Set([
        '/admin/profile/notifications','/admin/profile/notifications/currency','/admin/profile/notifications/telegram/start','/admin/profile/notifications/telegram/unlink','/admin/profile/notifications/discord/start','/admin/profile/notifications/discord/callback','/admin/profile/notifications/discord/unlink','/admin/profile/notifications/whatsapp'
    ]));
    router.use(globalNotificationRouter);
    router.use(createAdminAbuseProtectionRouter());
    router.use(createCustomerHistoryRouter());
    router.use(createCustomerPaymentReturnRouter());
    router.post('/account/trial/start',trialFreeLimit,requireCustomer,mutationGuard,async(req,res)=>{try{await lifecycle.startFreeTrial(req.session.customerId,req.body.planCode||null);return res.redirect('/account?welcome=1&message='+encodeURIComponent('Your trial is active. Your access details are below.'));}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message));}});
    router.post('/account/claim-free/:planCode',trialFreeLimit,requireCustomer,mutationGuard,async(req,res)=>{try{await lifecycle.claimFreePlan(req.session.customerId,req.params.planCode);return res.redirect('/account?welcome=1&message='+encodeURIComponent('Free Access claimed. Your access details are below.'));}catch(error){return res.redirect('/account?error='+encodeURIComponent(error.message));}});
    const legacy=core.createRouter();
    pruneRoutes(legacy,new Set([
        '/account','/account/register','/account/verify-email','/account/forgot-password','/account/reset-password',
        '/account/login','/account/logout','/account/checkout/stripe','/account/checkout/paypal','/account/paypal/return','/account/stripe/portal',
        '/account/jellyfin/:accountId/password','/account/trial/start','/account/claim-free/:planCode',
        '/admin/configuration','/admin/configuration/export','/admin/configuration/preview','/admin/configuration/apply','/admin/notifications/preferences',
        '/admin/plans/:id/commerce','/admin/plans/:id/provider'
    ]));
    router.use(legacy);return router;
}
module.exports={...core,createRouter,ensureFleetSnapshot,pruneRoutes};
