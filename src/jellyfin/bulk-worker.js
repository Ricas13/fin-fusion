'use strict';

// Generic executor for background_job_items. Claims a bounded batch with
// FOR UPDATE SKIP LOCKED (safe even with a single worker process, and free
// insurance against ever running two workers by accident), dispatches by
// job_type to a registered handler, and updates per-item + job status.
// Handlers are registered by the modules that own each job type (see
// registerHandler calls in admin bulk-operation routers) so this file stays
// generic and doesn't need to know about libraries/plans
// assignment/etc itself.

const crypto = require('crypto');
const { query, transaction } = require('../db');
const provisioning = require('./resilient-provisioning');

const BATCH_SIZE = 20;
const STALE_RUNNING_MINUTES = 10;
const handlers = new Map();

function registerHandler(jobType, fn) {
    handlers.set(jobType, fn);
}

async function claimBatch() {
    return transaction(async client => {
        const claimed = await client.query(`
            SELECT bji.id, bji.job_id, bji.customer_id, bji.attempt_count, bji.previous_state, bg.job_type, bg.params
            FROM background_job_items bji
            JOIN background_jobs bg ON bg.id = bji.job_id
            WHERE bji.status='pending'
            ORDER BY bji.id
            LIMIT $1
            FOR UPDATE OF bji SKIP LOCKED
        `, [BATCH_SIZE]);
        if (!claimed.rowCount) return [];
        const ids = claimed.rows.map(row => row.id);
        // A fresh, unique claim_token per item -- this is what lets
        // finishItem() later prove it's still completing the SAME claim it
        // started, not some earlier (reclaimed) claim on the same item id.
        const tokens = ids.map(() => crypto.randomUUID());
        await client.query(`
            UPDATE background_job_items AS bji SET status='running',claim_token=data.token,updated_at=NOW()
            FROM (SELECT UNNEST($1::bigint[]) AS id, UNNEST($2::uuid[]) AS token) AS data
            WHERE bji.id = data.id
        `, [ids, tokens]);
        const jobIds = Array.from(new Set(claimed.rows.map(row => row.job_id)));
        await client.query(`
            UPDATE background_jobs SET status='running',started_at=COALESCE(started_at,NOW())
            WHERE id=ANY($1::uuid[]) AND status='pending'
        `, [jobIds]);
        const tokenById = new Map(ids.map((id, i) => [id, tokens[i]]));
        return claimed.rows.map(row => ({ ...row, claim_token: tokenById.get(row.id) }));
    });
}

// A process crash (or container restart) between claiming an item and
// finishing it would otherwise leave that item 'running' forever -- the
// normal claim query only ever picks up 'pending' items, so nothing would
// ever revisit it. This never silently re-queues a stale item back to
// 'pending' for automatic reprocessing (that could double-apply a
// non-idempotent mutation if the crashed attempt actually completed);
// instead it fails the item explicitly so it shows up for an admin's
// deliberate Retry Failed action, same as any other failure.
async function reclaimStaleRunningItems() {
    const stale = await query(`
        UPDATE background_job_items
        SET status='failed',
            claim_token=NULL,
            last_error='Stale: claimed but never completed (worker crash or restart); marked failed for manual retry.',
            updated_at=NOW()
        WHERE status='running' AND updated_at < NOW() - make_interval(mins => $1)
        RETURNING id, job_id
    `, [STALE_RUNNING_MINUTES]);
    if (!stale.rowCount) return 0;
    const jobIds = Array.from(new Set(stale.rows.map(row => row.job_id)));
    for (const jobId of jobIds) {
        const reclaimedForJob = stale.rows.filter(row => row.job_id === jobId).length;
        await query(`UPDATE background_jobs SET failed_items=failed_items+$2 WHERE id=$1`, [jobId, reclaimedForJob]);
        const remaining = await query(`
            SELECT COUNT(*) FILTER(WHERE status IN ('pending','running'))::int AS pending,
                   COUNT(*) FILTER(WHERE status='failed')::int AS failed
            FROM background_job_items WHERE job_id=$1
        `, [jobId]);
        if (remaining.rows[0].pending === 0) {
            await query(`
                UPDATE background_jobs SET status=$2,completed_at=NOW()
                WHERE id=$1 AND status NOT IN ('cancelled','completed','completed_with_errors')
            `, [jobId, remaining.rows[0].failed > 0 ? 'completed_with_errors' : 'completed']);
        }
    }
    return stale.rowCount;
}

// Claim-aware / compare-and-set: this may only complete the EXACT claim it
// still holds (id + claim_token, and still 'running'). If a genuinely slow
// (not crashed) handler finishes after its claim was reclaimed as stale --
// and possibly already retried and re-claimed under a fresh token -- this
// late completion must be a complete no-op: it must not resurrect/overwrite
// whatever the current claim holder is doing, and must not double-count
// background_jobs' progress counters (reclaim already counted this item
// once as failed).
async function finishItem(item, ok, errorMessage, result) {
    const updated = await query(`
        UPDATE background_job_items
        SET status=$2,claim_token=NULL,attempt_count=attempt_count+1,last_error=$3,result=$4::jsonb,updated_at=NOW()
        WHERE id=$1 AND status='running' AND claim_token IS NOT DISTINCT FROM $5
        RETURNING id
    `, [item.id, ok ? 'succeeded' : 'failed', errorMessage || null, JSON.stringify(result || {}), item.claim_token]);
    if (!updated.rowCount) {
        console.warn(`Bulk job item ${item.id}: discarding a completion from an invalidated claim (already reclaimed and/or re-claimed)`);
        return;
    }
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

module.exports = { registerHandler, processBatch, reclaimStaleRunningItems, finishItem, BATCH_SIZE, STALE_RUNNING_MINUTES };
