'use strict';

// Generic bulk-job framework shared by admin bulk customer operations and
// plan-change reconciliation fanout. This module owns job/item CRUD and
// queueing only -- execution (the actual per-item mutation) lives in
// src/jellyfin/bulk-worker.js, dispatched by job_type. Keeping the two apart
// means every job type gets idempotency, bounded batching, retry-safety and
// audit trails for free just by going through here.

const crypto = require('crypto');
const { query, transaction } = require('../db');

const MAX_ITEMS_PER_JOB = 5000;

async function createJob(jobType, params, { createdBy = null, resellerScope = null, idempotencyKey = null } = {}) {
    if (idempotencyKey) {
        // INSERT-first (not SELECT-then-INSERT): the uniqueness check and the
        // insert must be one atomic operation, or two concurrent requests with
        // the same key can both pass the SELECT and both insert. ON CONFLICT
        // targets the NULLS NOT DISTINCT partial unique index from migration
        // 018, so this is race-safe even when created_by is NULL (system jobs).
        const inserted = await query(`
            INSERT INTO background_jobs(job_type,created_by,reseller_scope,idempotency_key,params,status)
            VALUES($1,$2,$3,$4,$5::jsonb,'pending')
            ON CONFLICT (created_by,idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
            RETURNING *
        `, [jobType, createdBy, resellerScope, idempotencyKey, JSON.stringify(params || {})]);
        if (inserted.rowCount) return { job: inserted.rows[0], reused: false };
        // Lost the race (or this is a genuine resubmission) -- fetch the
        // winner. IS NOT DISTINCT FROM (not =) so this still matches when
        // created_by is NULL, where plain SQL equality is never true.
        const existing = await query(
            'SELECT * FROM background_jobs WHERE created_by IS NOT DISTINCT FROM $1 AND idempotency_key=$2',
            [createdBy, idempotencyKey]
        );
        if (existing.rowCount) return { job: existing.rows[0], reused: true };
        throw new Error('Job creation conflicted but the existing job could not be found');
    }
    const result = await query(`
        INSERT INTO background_jobs(job_type,created_by,reseller_scope,params,status)
        VALUES($1,$2,$3,$4::jsonb,'pending')
        RETURNING *
    `, [jobType, createdBy, resellerScope, JSON.stringify(params || {})]);
    return { job: result.rows[0], reused: false };
}

// Inserts one item per customer id, deduplicated. Caller must have already
// re-resolved these customer ids server-side against the caller's
// authorization scope -- this function does not re-check ownership, it only
// persists what it's given.
async function enqueueItems(jobId, customerIds) {
    const ids = Array.from(new Set((customerIds || []).filter(Boolean))).slice(0, MAX_ITEMS_PER_JOB);
    if (!ids.length) return 0;
    return transaction(async client => {
        const inserted = await client.query(`
            INSERT INTO background_job_items(job_id,customer_id)
            SELECT $1,x FROM UNNEST($2::uuid[]) AS x
            ON CONFLICT (job_id,customer_id) DO NOTHING
            RETURNING id
        `, [jobId, ids]);
        await client.query(`
            UPDATE background_jobs SET total_items=(SELECT COUNT(*)::int FROM background_job_items WHERE job_id=$1) WHERE id=$1
        `, [jobId]);
        return inserted.rowCount;
    });
}

async function getJob(jobId) {
    const result = await query('SELECT * FROM background_jobs WHERE id=$1', [jobId]);
    return result.rows[0] || null;
}

// actorScope: { isReseller, resellerId } -- when the caller is a reseller,
// only jobs they themselves created/own may be viewed or retried. Admins
// (actorScope=null) may view/retry any job. This is re-checked here, not
// left to the route layer, so every caller of this module gets the same
// guarantee regardless of how it's invoked.
async function getJobForActor(jobId, actorScope) {
    const job = await getJob(jobId);
    if (!job) return null;
    if (actorScope?.isReseller && job.reseller_scope !== actorScope.resellerId) return null;
    return job;
}

async function listJobItems(jobId, { status = null, limit = 500 } = {}) {
    const params = [jobId];
    let where = 'job_id=$1';
    if (status) { params.push(status); where += ` AND status=$${params.length}`; }
    params.push(Math.min(Number(limit) || 500, 2000));
    const result = await query(`
        SELECT bji.*,COALESCE(c.display_name,au.username,c.email,'Customer') AS customer_name
        FROM background_job_items bji
        LEFT JOIN customers c ON c.id=bji.customer_id
        LEFT JOIN app_users au ON au.id=c.user_id
        WHERE ${where}
        ORDER BY bji.id
        LIMIT $${params.length}
    `, params);
    return result.rows;
}

async function jobCounts(jobId) {
    const result = await query(`
        SELECT status,COUNT(*)::int n FROM background_job_items WHERE job_id=$1 GROUP BY status
    `, [jobId]);
    const counts = { pending: 0, running: 0, succeeded: 0, failed: 0, skipped: 0 };
    for (const row of result.rows) counts[row.status] = row.n;
    return counts;
}

// Resets failed items back to pending so the worker's normal claim loop
// picks them up. Succeeded items are never touched by this -- a retry pass
// can only ever re-run items that are still in the 'failed' state.
async function retryFailedItems(jobId, actorScope) {
    const job = await getJobForActor(jobId, actorScope);
    if (!job) throw new Error('Job not found');
    const result = await query(`
        UPDATE background_job_items SET status='pending',last_error=NULL,updated_at=NOW()
        WHERE job_id=$1 AND status='failed'
        RETURNING id
    `, [jobId]);
    if (result.rowCount) {
        await query(`UPDATE background_jobs SET status='running',failed_items=GREATEST(failed_items-$2,0) WHERE id=$1`, [jobId, result.rowCount]);
    }
    return result.rowCount;
}

function newIdempotencyKey() {
    return crypto.randomUUID();
}

// ---- Plan-change reconciliation fanout ---------------------------------

async function affectedCustomerIdsForPlan(planId) {
    const result = await query(`
        SELECT DISTINCT customer_id FROM subscriptions
        WHERE plan_id=$1 AND status IN ('active','trialing','past_due') AND current_period_end>NOW()
    `, [planId]);
    return result.rows.map(r => r.customer_id);
}

// Called after a plan's Jellyfin/library settings are saved. Queues a
// bounded, retry-safe background job that reconciles every currently active
// customer on that plan, instead of blocking the admin's save request.
// Returns null (no job) when nothing is affected.
async function queuePlanReconciliation(planId, actorUserId) {
    const customerIds = await affectedCustomerIdsForPlan(planId);
    if (!customerIds.length) return null;
    const { job } = await createJob('plan_reconcile', { planId }, { createdBy: actorUserId });
    await enqueueItems(job.id, customerIds);
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'admin.plan.reconcile_queued','plan',$2,$3::jsonb)
    `, [actorUserId, planId, JSON.stringify({ jobId: job.id, affected: customerIds.length })]);
    return getJob(job.id);
}

module.exports = {
    MAX_ITEMS_PER_JOB,
    createJob,
    enqueueItems,
    getJob,
    getJobForActor,
    listJobItems,
    jobCounts,
    retryFailedItems,
    newIdempotencyKey,
    affectedCustomerIdsForPlan,
    queuePlanReconciliation
};
