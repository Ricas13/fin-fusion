'use strict';

const { expireSubscriptionsAndReconcile } = require('../jellyfin/provisioning');
const { reconcileActiveEntitlements, healthcheckAllServers } = require('../jellyfin/jobs');
const drift = require('../jellyfin/drift-control');
const bulkWorker = require('../jellyfin/bulk-worker');
const requestUserSync = require('../integrations/request-user-sync');
const requestServiceSettings = require('../integrations/request-service-settings');
const emailSettings = require('../integrations/email-settings');
const emailOutbox = require('../integrations/email-outbox');
const notificationOutbox = require('../integrations/notification-outbox');
const billingControl = require('../payments/billing-control');
const customerPlanChange = require('../payments/customer-plan-change');
const resellerJobs = require('../resellers/jobs');
const resellerNotifications = require('../resellers/notification-job');
require('../platform/bulk-operations');

const jobs = {
    async health() {
        const results = await healthcheckAllServers();
        return { total: results.length, failed: results.filter(item => !item.ok).length };
    },
    async entitlements() {
        const expired = await expireSubscriptionsAndReconcile();
        const active = await reconcileActiveEntitlements();
        return { ...active, expired, processed: Number(expired || 0) + Number(active.total || 0) };
    },
    async policy_drift() {
        const result = await drift.auditDue({ all: false });
        return { ...result, processed: Number(result.total || 0), failed: Number(result.unreachable || 0) };
    },
    async bulk_jobs() { return bulkWorker.processBatch(); },
    async stale_reclaim() {
        const reclaimed = await bulkWorker.reclaimStaleRunningItems();
        return { processed: Number(reclaimed || 0), reclaimed: Number(reclaimed || 0) };
    },
    async email_outbox() {
        const status = await emailSettings.status();
        if (!status.configured) return { processed: 0, skipped: 'email_not_configured' };
        return emailOutbox.deliverDue({ limit: 50 });
    },
    async notification_outbox() { return notificationOutbox.deliverDue({ limit: 50 }); },
    async request_users() {
        await requestServiceSettings.ensureLoaded();
        const config = await requestUserSync.configuration();
        if (!config.configured) return { processed: 0, skipped: 'request_service_not_configured' };
        const result = await requestUserSync.syncAll();
        return { ...result, processed: Number(result.total || 0) };
    },
    async billing() { return billingControl.syncDue({ all: false, limit: 100 }); },
    async plan_changes() { return customerPlanChange.applyDueStripe(); },
    async reseller_billing() { return resellerJobs.syncProviderSubscriptions(); },
    async reseller_estates() { return resellerJobs.reconcileSubscribedEstates(); },
    async reseller_notifications() { return resellerNotifications.process(); }
};

function names() { return Object.keys(jobs); }
async function run(jobKey) {
    const job = jobs[jobKey];
    if (!job) throw new Error(`Unknown automation job: ${jobKey}`);
    return job();
}
module.exports = { jobs, names, run };
