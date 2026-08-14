'use strict';

// Generic executor for background_job_items. Claims a bounded batch with
// FOR UPDATE SKIP LOCKED (safe even with a single worker process, and free
// insurance against ever running two workers by accident), dispatches by
// job_type to a registered handler, and updates per-item + job status.
// Handlers are registered by the modules that own each job type (see
// registerHandler calls in admin bulk-operation routers) so this file stays
// generic and doesn't need to know about libraries/plans/reseller
// assignment/etc itself.

const { query, transaction } = require('../db');
const provisioning = require('./provisioning');

const BATCH_SIZE = 20;
const handlers = new Map();

function registerHandler(jobType, fn) {
    handlers.set(jobType, fn);
}

async function claimBatch() {
    return transaction(async client => {
        const claimed = await client.query(`
            SELECT bji.id, bji.job_id, bji.customer_id, bji.attempt_count, bg.job_type, bg.params
            FROM background_job_items bji
            JOIN background_jobs bg ON bg.id = bji.job_id
            WHERE bji.status='pending'
            ORDER BY bji.id
            LIMIT $1
            FOR UPDATE OF bji SKIP LOCKED
        `, [BATCH_SIZE]);
        if (!claimed.rowCount) return [];
        const ids = claimed.rows.map(row => row.id);
        await client.query(`UPDATE background_job_items SET status='running',updated_at=NOW() WHERE id=ANY($1::bigint[])`, [ids]);
        const jobIds = Array.from(new Set(claimed.rows.map(row => row.job_id)));
        await client.query(`
            UPDATE background_jobs SET status='running',started_at=COALESCE(started_at,NOW())
            WHERE id=ANY($1::uuid[]) AND status='pending'
        `, [jobIds]);
        return claimed.rows;
    });
}

async function finishItem(item, ok, errorMessage, result) {
    await query(`
        UPDATE background_job_items
        SET status=$2,attempt_count=attempt_count+1,last_error=$3,result=$4::jsonb,updated_at=NOW()
        WHERE id=$1
    `, [item.id, ok ? 'succeeded' : 'failed', errorMessage || null, JSON.stringify(result || {})]);
    await query(`
        UPDATE background_jobs SET succeeded_items=succeeded_items+$2,failed_items=failed_items+$3 WHERE id=$1
    `, [item.job_id, ok ? 1 : 0, ok ? 0 : 1]);
    const remaining = await query(`
        SELECT COUNT(*) FILTER(WHERE status IN ('pending','running'))::int AS pending,
               COUNT(*) FILTER(WHERE status='failed')::int AS failed
        FROM background_job_items WHERE job_id=$1
    `, [item.job_id]);
    const { pending, failed } = remaining.rows[0];
    if (pending === 0) {
        await query(`
            UPDATE background_jobs SET status=$2,completed_at=NOW()
            WHERE id=$1 AND status NOT IN ('cancelled','completed','completed_with_errors')
        `, [item.job_id, failed > 0 ? 'completed_with_errors' : 'completed']);
    }
}

async function processBatch() {
    const items = await claimBatch();
    for (const item of items) {
        try {
            const handler = handlers.get(item.job_type);
            if (!handler) throw new Error(`No handler registered for job type "${item.job_type}"`);
            const result = await handler(item);
            await finishItem(item, true, null, result);
        } catch (error) {
            await finishItem(item, false, String(error?.message || error).slice(0, 500), null);
        }
    }
    return items.length;
}

// Plan-change reconciliation fanout: reconcile the customer's Jellyfin
// accounts against their current entitlement (which already reflects the
// plan change that queued this job). Registered here since it belongs to
// the provisioning domain this file already depends on; other job types are
// registered by the routers that define them.
registerHandler('plan_reconcile', async item => {
    const outcome = await provisioning.reconcileCustomer(item.customer_id);
    return { active: Boolean(outcome?.active) };
});

module.exports = { registerHandler, processBatch, BATCH_SIZE };
