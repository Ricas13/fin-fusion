'use strict';

// One-time operator script: run once after deploying the "allow subtitle
// editing" plan permission (migration 100) so already-provisioned Jellyfin
// customers get the new default pushed to their live Jellyfin account,
// instead of waiting for an admin to re-save each plan's Access policy by
// hand. Safe to run more than once -- it only queues the same bounded,
// idempotent reconciliation job every "Save access" click already queues.

require('dotenv').config();
const { query, getPool } = require('../src/db');
const { queuePlanReconciliation } = require('../src/platform/bulk-jobs');

(async () => {
    const plans = await query(`
        SELECT id, code, name FROM plans
        WHERE archived_at IS NULL AND COALESCE(service_type, 'jellyfin') IN ('jellyfin', 'bundle')
        ORDER BY name
    `);
    if (!plans.rowCount) {
        console.log('No Jellyfin/bundle plans found; nothing to queue.');
        return;
    }
    let queued = 0;
    for (const plan of plans.rows) {
        const job = await queuePlanReconciliation(plan.id, null);
        if (job) {
            queued += 1;
            console.log(`Queued reconciliation for "${plan.name}" (${plan.code}): job ${job.id}`);
        } else {
            console.log(`Skipped "${plan.name}" (${plan.code}): no live customer entitlements to reconcile.`);
        }
    }
    console.log(`Done. ${queued}/${plans.rowCount} plan(s) queued for reconciliation.`);
})().catch(error => {
    console.error(`Subtitle-management backfill failed: ${error.message}`);
    process.exitCode = 1;
}).finally(async () => {
    try { await getPool().end(); } catch (_) {}
});
