'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const firstRun = require('./auth/first-run-setup');
const controller = require('./auth/staff-controller');
const { guardSession } = require('./auth/session-guard');
const runtimeSettings = require('./platform/runtime-settings');
const { consumeLoginAttempt, pruneLoginRateLimits } = require('./security/login-rate-limit');
const customerRateLimit = require('./security/customer-rate-limit');

const IS_PRODUCTION = String(process.env.NODE_ENV || '').toLowerCase() === 'production';
const PORT = Number(process.env.PORT || 3030);
const SESSION_SECRET = String(process.env.SESSION_SECRET || '');

function fail(message) { throw new Error(`Startup configuration error: ${message}`); }
function validateEnvironment() {
    if (IS_PRODUCTION && !process.env.DATABASE_URL) fail('DATABASE_URL is required in production.');
    if (!SESSION_SECRET || SESSION_SECRET.length < 32 || /change[-_ ]?(me|this)|example|placeholder/i.test(SESSION_SECRET)) fail('SESSION_SECRET must be a unique random value of at least 32 characters.');
    if (process.env.ADMIN_PASSWORD && String(process.env.ADMIN_PASSWORD).length < 12) fail('ADMIN_PASSWORD must be at least 12 characters when supplied.');
    if (String(process.env.ADMIN_PASSWORD || '') === 'admin123') fail('The legacy admin123 password is not permitted.');
}

function securityHeaders(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    if (IS_PRODUCTION) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    if (!['GET','HEAD','OPTIONS'].includes(req.method)) {
        if (req.get('sec-fetch-site') === 'cross-site') return res.status(403).send('Cross-site request blocked');
        const origin=req.get('origin'),forwardedHost=req.get('x-forwarded-host')||req.get('host');
        if(origin&&forwardedHost){try{if(new URL(origin).host!==forwardedHost)return res.status(403).send('Origin mismatch');}catch(_){return res.status(403).send('Invalid origin');}}
    }
    return next();
}

function sessionMiddleware() {
    const options={secret:SESSION_SECRET,name:process.env.SESSION_COOKIE_NAME||'steamfusion.sid',proxy:true,resave:false,saveUninitialized:false,cookie:{maxAge:24*60*60*1000,httpOnly:true,sameSite:'lax',secure:process.env.COOKIE_SECURE?process.env.COOKIE_SECURE==='true':IS_PRODUCTION}};
    if(process.env.DATABASE_URL)options.store=new PgStore({conString:process.env.DATABASE_URL,createTableIfMissing:true,tableName:'user_sessions',pruneSessionInterval:15*60});
    return session(options);
}

async function staffLoginRateLimit(req,res,next){if(req.method!=='POST'||req.path!=='/login')return next();try{const result=await consumeLoginAttempt(req.ip||req.socket?.remoteAddress||'unknown',{windowMs:Number(process.env.LOGIN_RATE_LIMIT_WINDOW_MS||15*60*1000),maxAttempts:Number(process.env.LOGIN_RATE_LIMIT_MAX_ATTEMPTS||10),secret:SESSION_SECRET});res.setHeader('X-RateLimit-Limit',String(result.maxAttempts));res.setHeader('X-RateLimit-Remaining',String(Math.max(0,result.maxAttempts-result.attemptCount)));if(!result.allowed){res.setHeader('Retry-After',String(Math.max(1,result.retryAfterSeconds)));return res.status(429).send('Too many login attempts. Try again later.');}return next();}catch(error){console.error('Persistent staff login limiter unavailable:',error.message);if(IS_PRODUCTION)return res.status(503).send('Login temporarily unavailable. Try again shortly.');return next();}}
async function customerAuthRateLimit(req,res,next){if(req.method!=='POST'||!['/account/login','/account/forgot-password'].includes(req.path))return next();const reset=req.path==='/account/forgot-password';try{const result=await customerRateLimit.consume(`${reset?'customer-reset':'customer-login'}:${req.ip||req.socket?.remoteAddress||'unknown'}`,{limit:reset?5:10,windowMs:15*60*1000});if(!result.allowed){res.setHeader('Retry-After',String(Math.max(1,Math.ceil((result.resetAt.getTime()-Date.now())/1000))));return res.status(429).send(reset?'Too many password reset requests. Try again later.':'Too many login attempts. Try again later.');}return next();}catch(error){console.error('Persistent customer auth limiter unavailable:',error.message);if(IS_PRODUCTION)return res.status(503).send('Authentication temporarily unavailable.');return next();}}
async function loginSetupGate(req,res,next){try{if(await firstRun.isSetupRequired())return res.redirect('/setup');await runtimeSettings.ensureLoaded().catch(()=>{});return next();}catch(error){return next(error);}}

function mountPlatform(app) {
    const {createWebhookRouter}=require('./platform/webhooks');
    app.use(createWebhookRouter());
    app.use(express.urlencoded({extended:true,limit:'1mb'}));
    app.use(express.json({limit:'1mb'}));
    app.use(express.static(path.join(__dirname,'..','public'),{maxAge:IS_PRODUCTION?'1h':0}));
    app.use(sessionMiddleware());app.use(guardSession);app.use(staffLoginRateLimit);app.use(customerAuthRateLimit);

    const {createFirstRunRouter}=require('./auth/first-run-controller');
    const {createAdminSecurityRouter}=require('./platform/admin-security');
    app.use(createFirstRunRouter());app.get('/login',loginSetupGate,controller.loginPage);app.post('/login',loginSetupGate,controller.loginSubmit);app.get('/logout',controller.logout);app.use(controller.createAuthRouter());app.use(createAdminSecurityRouter());

    const {storefrontPage}=require('./platform/storefront');
    app.get('/',async(req,res,next)=>{try{if(await firstRun.isSetupRequired())return res.redirect('/setup');return storefrontPage(req,res,next);}catch(error){return next(error);}});

    const {createRouter}=require('./platform/router');
    const {createCustomerPasswordSyncRouter}=require('./platform/customer-password-sync');
    const {createFlexibleCheckoutRouter}=require('./platform/flexible-checkout');
    const {createInviteOnboardingRouter}=require('./platform/invite-onboarding');
    const {createCustomerClaimRouter}=require('./platform/customer-claim');
    const {createAdminCatalogShellRouter}=require('./platform/admin-catalog-shell');
    const {createAdminPlansListRouter}=require('./platform/admin-plans-list');
    const {createAdminPlanLibrariesRouter}=require('./platform/admin-plan-libraries');
    const {createAdminPlanPlacementFleetRouter}=require('./platform/admin-plan-placement-fleet');
    const {createAdminPlanPlacementRouter}=require('./platform/admin-plan-placement');
    const {createAdminPlanPaymentOptionsRouter}=require('./platform/admin-plan-payment-options');
    const {createAdminPaymentSettingsRouter}=require('./platform/admin-payment-settings');
    const {createAdminBillingRouter}=require('./platform/admin-billing');
    const {createAdminEmailRouter}=require('./platform/admin-email');
    const {createAdminInvitationsRouter}=require('./platform/admin-invitations');
    const {createAdminProvisioningRouter}=require('./platform/admin-provisioning');
    const {createAdminRequestUsersRouter}=require('./platform/admin-request-users');
    const {createAdminRequestPlanPolicyRouter}=require('./platform/admin-request-plan-policy');
    const {createAdminRequestRedirectRouter}=require('./platform/admin-request-redirect');
    const {createAdminServerMigrationsRouter}=require('./platform/admin-server-migrations');
    const {createAdminJellyfinImportRouter}=require('./platform/admin-jellyfin-import');
    const {createAdminSetupRouter}=require('./platform/admin-setup');
    const {createAdminConfigurationTransferRouter}=require('./platform/admin-configuration-transfer');
    const {createAdminLibrariesRouter}=require('./platform/admin-libraries');
    const {createAdminShellRouter}=require('./platform/admin-shell');
    const {createAdminServerFleetDashboardRouter}=require('./platform/admin-server-fleet-dashboard');
    const {createAdminServerLibraryDashboardRouter}=require('./platform/admin-server-library-dashboard');
    const {createAdminOriginalSettingsRouter}=require('./platform/admin-original-settings');
    const {createAdminBrandingRouter}=require('./platform/admin-branding');
    const {createBrandingRouter}=require('./platform/branding');
    const {createAdminPreviewRouter}=require('./platform/admin-preview');
    const {createAdminResellerSummaryRouter}=require('./platform/admin-reseller-summary');
    const {createAdminResellersRouter}=require('./platform/admin-resellers');
    const {createAdminResellerTiersRouter}=require('./platform/admin-reseller-tiers');
    const {createResellerMonthlyPortalRouter}=require('./platform/reseller-monthly-portal');
    const {createAdminActivityRouter}=require('./platform/admin-activity');
    const {createAdminCustomer360Router}=require('./platform/admin-customer-360');
    const {createAdminUsersRouter}=require('./platform/admin-users');
    const {createAdminServersRouter}=require('./platform/admin-servers');
    const {createAdminDiscountsRouter}=require('./platform/admin-discounts');
    const {createAdminReferralsRouter}=require('./platform/admin-referrals');
    const {createAdminPlansRouter}=require('./platform/admin-plans');
    const {createAdminJobsRouter}=require('./platform/admin-jobs');
    const {createAdminBulkCustomersRouter}=require('./platform/admin-bulk-customers');
    const {createAdminCustomersListRouter}=require('./platform/admin-customers-list');
    const dashboard=require('./platform/admin-dashboard');

    app.use(createBrandingRouter());app.use(createInviteOnboardingRouter());app.use(createCustomerClaimRouter());app.use(createCustomerPasswordSyncRouter());app.use(createFlexibleCheckoutRouter());app.use(createAdminPreviewRouter());app.use(createResellerMonthlyPortalRouter());
    app.get('/admin',dashboard.dashboardPage);
    app.use(createAdminSetupRouter());app.use(createAdminConfigurationTransferRouter());app.use(createAdminOriginalSettingsRouter());app.use(createAdminBrandingRouter());app.use(createAdminResellerTiersRouter());app.use(createAdminResellerSummaryRouter());app.use(createAdminResellersRouter());app.use(createAdminInvitationsRouter());app.use(createAdminJellyfinImportRouter());app.use(createAdminServerMigrationsRouter());app.use(createAdminRequestPlanPolicyRouter());app.use(createAdminRequestUsersRouter());app.use(createAdminRequestRedirectRouter());app.use(createAdminProvisioningRouter());app.use(createAdminEmailRouter());app.use(createAdminPaymentSettingsRouter());app.use(createAdminBillingRouter());app.use(createAdminCatalogShellRouter());app.use(createAdminPlansListRouter());app.use(createAdminPlanPaymentOptionsRouter());app.use(createAdminPlansRouter());app.use(createAdminPlanPlacementFleetRouter());app.use(createAdminPlanPlacementRouter());app.use(createAdminJobsRouter());app.use(createAdminBulkCustomersRouter());app.use(createAdminCustomersListRouter());app.use(createAdminPlanLibrariesRouter());app.use(createAdminServerFleetDashboardRouter());app.use(createAdminServerLibraryDashboardRouter());app.use(createAdminShellRouter());app.use(createAdminServersRouter());app.use(createAdminActivityRouter());app.use(createAdminLibrariesRouter());app.use(createAdminCustomer360Router());app.use(createAdminUsersRouter());app.use(createAdminDiscountsRouter());app.use(createAdminReferralsRouter());app.use(createRouter());
}

function createApplication(){validateEnvironment();const app=express();app.set('trust proxy',1);app.disable('x-powered-by');app.set('view engine','ejs');app.set('views',path.join(__dirname,'..','views'));app.use(securityHeaders);mountPlatform(app);app.use((req,res)=>res.status(404).send('Not found'));app.use((error,req,res,_next)=>{console.error(`${req.method} ${req.originalUrl} failed:`,error.message);if(res.headersSent)return;const status=Number(error.status||error.statusCode||500);res.status(status>=400&&status<600?status:500).send(status>=500?'Request failed.':error.message);});return app;}
function start(){const app=createApplication(),server=app.listen(PORT,()=>console.log(`CAPTaINFiN web application listening on http://127.0.0.1:${PORT}`));const prune=setInterval(()=>{Promise.all([pruneLoginRateLimits(),customerRateLimit.cleanup()]).catch(error=>console.warn('Rate-limit cleanup failed:',error.message));},60*60*1000);prune.unref?.();return{app,server};}
if(require.main===module)start();
module.exports={createApplication,start,securityHeaders,validateEnvironment};
