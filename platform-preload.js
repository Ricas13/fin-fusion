'use strict';

/**
 * Bridges the PostgreSQL platform into the legacy Express app while preserving
 * the existing admin/reseller routes during migration.
 */

const expressPath = require.resolve('express');
const realExpress = require(expressPath);
const { createWebhookRouter } = require('./src/platform/webhooks');

const originalListen = realExpress.application.listen;
let jobsStarted = false;
const customerLoginAttempts = new Map();

function customerLoginThrottle(req, res, next) {
    if (req.method !== 'POST' || req.path !== '/account/login') return next();
    const now = Date.now();
    const windowMs = 15 * 60 * 1000;
    const maxAttempts = 10;
    const key = req.ip || req.socket?.remoteAddress || 'unknown';
    let bucket = customerLoginAttempts.get(key);
    if (!bucket || now - bucket.startedAt > windowMs) bucket = { startedAt: now, count: 0 };
    bucket.count += 1;
    customerLoginAttempts.set(key, bucket);
    if (bucket.count > maxAttempts) {
        res.setHeader('Retry-After', Math.max(1, Math.ceil((windowMs - (now - bucket.startedAt)) / 1000)));
        return res.status(429).send('Too many login attempts. Try again later.');
    }
    return next();
}

function requestUserSyncIntervalMs() {
    const configured = Number(process.env.REQUEST_USER_SYNC_INTERVAL_MS);
    if (!Number.isFinite(configured) || configured <= 0) return 15 * 60 * 1000;
    return Math.max(5 * 60 * 1000, configured);
}

function startJobs() {
    if (jobsStarted || !process.env.DATABASE_URL) return;
    jobsStarted = true;
    const { expireSubscriptionsAndReconcile } = require('./src/jellyfin/resilient-provisioning');
    const { reconcileActiveEntitlements, healthcheckAllServers } = require('./src/jellyfin/jobs');
    const bulkWorker = require('./src/jellyfin/bulk-worker');
    const requestUserSync = require('./src/integrations/request-user-sync');
    require('./src/platform/bulk-operations');
    const runtimeSettings = require('./src/platform/runtime-settings');
    const { createRescheduler } = require('./src/platform/reschedule-timer');
    const runEntitlements = async () => {
        try {
            const expired = await expireSubscriptionsAndReconcile();
            const active = await reconcileActiveEntitlements();
            if (expired || active.failed || active.blocked) {
                console.log(`Entitlement job: expired=${expired}, due=${active.total}, succeeded=${active.succeeded}, blocked=${active.blocked}, failed=${active.failed}`);
            }
        } catch (error) { console.error('Entitlement job failed:', error.message); }
    };
    const runHealth = async () => {
        try {
            const results = await healthcheckAllServers();
            const offline = results.filter(r => !r.ok);
            if (offline.length) console.warn(`Jellyfin health check: ${offline.length}/${results.length} server(s) unavailable`);
        } catch (error) { console.error('Jellyfin health job failed:', error.message); }
    };
    const runBulkJobs = async () => {
        try { await bulkWorker.processBatch(); }
        catch (error) { console.error('Bulk job worker failed:', error.message); }
    };
    const runStaleReclaim = async () => {
        try {
            const reclaimed = await bulkWorker.reclaimStaleRunningItems();
            if (reclaimed) console.warn(`Bulk job worker: reclaimed ${reclaimed} stale 'running' item(s) as failed`);
        } catch (error) { console.error('Stale bulk job reclaim failed:', error.message); }
    };
    const runRequestUsers = async () => {
        try {
            const config = await requestUserSync.configuration();
            if (!config.configured) return;
            const result = await requestUserSync.syncAll();
            if (result.created || result.suspended || result.failed) {
                console.log(`Request user sync: total=${result.total}, created=${result.created}, linked=${result.linked}, suspended=${result.suspended}, failed=${result.failed}`);
            }
        } catch (error) { console.error('Request user sync failed:', error.message); }
    };
    const initialEntitlement = setTimeout(runEntitlements, 15000);
    const initialHealth = setTimeout(runHealth, 5000);
    const initialRequestUsers = setTimeout(runRequestUsers, 30000);
    initialEntitlement.unref?.(); initialHealth.unref?.(); initialRequestUsers.unref?.();
    createRescheduler(runBulkJobs, () => 3000).start();
    createRescheduler(runStaleReclaim, () => 60000).start();
    createRescheduler(runRequestUsers, requestUserSyncIntervalMs).start();
    runtimeSettings.ensureLoaded()
        .catch(error => console.error('Runtime settings load failed, using env defaults:', error.message))
        .finally(() => {
            createRescheduler(runEntitlements, runtimeSettings.entitlementJobIntervalMs).start();
            createRescheduler(runHealth, runtimeSettings.serverHealthIntervalMs).start();
        });
}

function platformExpress(...args) { const app = realExpress(...args); app.use(createWebhookRouter()); return app; }
Object.assign(platformExpress, realExpress);
platformExpress.application = realExpress.application;
platformExpress.request = realExpress.request;
platformExpress.response = realExpress.response;
require.cache[expressPath].exports = platformExpress;

realExpress.application.listen = function platformListen(...args) {
    if (!this.locals.__platformRoutesMounted && process.env.DATABASE_URL) {
        this.locals.__platformRoutesMounted = true;
        const { createRouter } = require('./src/platform/router');
        const { createInviteOnboardingRouter } = require('./src/platform/invite-onboarding');
        const { createAdminCatalogShellRouter } = require('./src/platform/admin-catalog-shell');
        const { createAdminPlansListRouter } = require('./src/platform/admin-plans-list');
        const { createAdminPlanLibrariesRouter } = require('./src/platform/admin-plan-libraries');
        const { createAdminPlanPlacementRouter } = require('./src/platform/admin-plan-placement');
        const { createAdminInvitationsRouter } = require('./src/platform/admin-invitations');
        const { createAdminProvisioningRouter } = require('./src/platform/admin-provisioning');
        const { createAdminRequestUsersRouter } = require('./src/platform/admin-request-users');
        const { createAdminRequestPlanPolicyRouter } = require('./src/platform/admin-request-plan-policy');
        const { createAdminServerMigrationsRouter } = require('./src/platform/admin-server-migrations');
        const { createAdminSetupRouter } = require('./src/platform/admin-setup');
        const { createAdminConfigurationTransferRouter } = require('./src/platform/admin-configuration-transfer');
        const { createAdminLibrariesRouter } = require('./src/platform/admin-libraries');
        const { createAdminShellRouter } = require('./src/platform/admin-shell');
        const { createAdminServerLibraryDashboardRouter } = require('./src/platform/admin-server-library-dashboard');
        const { createAdminOriginalSettingsRouter } = require('./src/platform/admin-original-settings');
        const { createAdminBrandingRouter } = require('./src/platform/admin-branding');
        const { createBrandingRouter } = require('./src/platform/branding');
        const { createAdminPreviewRouter } = require('./src/platform/admin-preview');
        const { createAdminResellerSummaryRouter } = require('./src/platform/admin-reseller-summary');
        const { createAdminResellersRouter } = require('./src/platform/admin-resellers');
        const { createAdminActivityRouter } = require('./src/platform/admin-activity');
        const { createAdminCustomer360Router } = require('./src/platform/admin-customer-360');
        const { createAdminUsersRouter } = require('./src/platform/admin-users');
        const { createAdminServersRouter } = require('./src/platform/admin-servers');
        const { createAdminDiscountsRouter } = require('./src/platform/admin-discounts');
        const { createAdminReferralsRouter } = require('./src/platform/admin-referrals');
        const { createAdminPlansRouter } = require('./src/platform/admin-plans');
        const { createAdminJobsRouter } = require('./src/platform/admin-jobs');
        const { createAdminBulkCustomersRouter } = require('./src/platform/admin-bulk-customers');
        const { createAdminCustomersListRouter } = require('./src/platform/admin-customers-list');
        const resellerPortal = require('./src/platform/reseller-portal');
        this.use(customerLoginThrottle);
        this.use(createBrandingRouter());
        this.use(createInviteOnboardingRouter());
        this.use(createAdminPreviewRouter());
        this.get('/reseller/export', resellerPortal.gate, resellerPortal.noStore, resellerPortal.exportClientsCsv);
        this.use(createAdminSetupRouter());
        this.use(createAdminConfigurationTransferRouter());
        this.use(createAdminOriginalSettingsRouter());
        this.use(createAdminBrandingRouter());
        this.use(createAdminResellerSummaryRouter());
        this.use(createAdminResellersRouter());
        this.use(createAdminInvitationsRouter());
        this.use(createAdminServerMigrationsRouter());
        this.use(createAdminRequestPlanPolicyRouter());
        this.use(createAdminRequestUsersRouter());
        this.use(createAdminProvisioningRouter());
        this.use(createAdminCatalogShellRouter());
        this.use(createAdminPlansListRouter());
        this.use(createAdminPlansRouter());
        this.use(createAdminPlanPlacementRouter());
        this.use(createAdminJobsRouter());
        this.use(createAdminBulkCustomersRouter());
        this.use(createAdminCustomersListRouter());
        this.use(createAdminPlanLibrariesRouter());
        this.use(createAdminServerLibraryDashboardRouter());
        this.use(createAdminShellRouter());
        this.use(createAdminServersRouter());
        this.use(createAdminActivityRouter());
        this.use(createAdminLibrariesRouter());
        this.use(createAdminCustomer360Router());
        this.use(createAdminUsersRouter());
        this.use(createAdminDiscountsRouter());
        this.use(createAdminReferralsRouter());
        this.use(createRouter());
        startJobs();
    }
    return originalListen.apply(this, args);
};

module.exports = { requestUserSyncIntervalMs };
