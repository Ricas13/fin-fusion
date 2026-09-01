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

async function createJob(jobType, params, { createdBy = null, idempotencyKey = null } = {}) {
    if (idempotencyKey) {
        return transaction(async client => {
            await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`bulk-job:${createdBy || 'system'}:${idempotencyKey}`]);
            const existing = await client.query(
                'SELECT * FROM background_jobs WHERE created_by IS NOT DISTINCT FROM $1 AND idempotency_key=$2',
                [createdBy, idempotencyKey]
            );
            if (existing.rowCount) return { job: existing.rows[0], reused: true };
            const inserted = await client.query(`
                INSERT INTO background_jobs(job_type,created_by,idempotency_key,params,status)
                VALUES($1,$2,$3,$4::jsonb,'pending')
                RETURNING *
            `, [jobType, createdBy, idempotencyKey, JSON.stringify(params || {})]);
            return { job: inserted.rows[0], reused: false };
        });
    }
    const result = await query(`
        INSERT INTO background_jobs(job_type,created_by,params,status)
        VALUES($1,$2,$3::jsonb,'pending')
        RETURNING *
    `, [jobType, createdBy, JSON.stringify(params || {})]);
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

async function getJobForActor(jobId, _actorScope) {
    return getJob(jobId);
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

// One definition of "currently on this plan" for every plan-level fanout.
// Keep this aligned with the plan editors/effective entitlement window so a
// paused customer is not silently left on stale limits and a superseded or
// not-yet-started subscription is never mutated by the old plan.
async function affectedCustomerIdsForPlan(planId) {
    const result = await query(`
        SELECT DISTINCT customer_id FROM subscriptions
        WHERE plan_id=$1
          AND superseded_by IS NULL
          AND status IN ('active','trialing','past_due','paused')
          AND starts_at<=NOW()
          AND current_period_end>NOW()
    `, [planId]);
    return result.rows.map(r => r.customer_id);
}

async function queuePlanCustomerJob(jobType, planId, actorUserId, auditAction, jobParams = {}) {
    const customerIds = await affectedCustomerIdsForPlan(planId);
    if (!customerIds.length) return null;
    const params = { ...(jobParams || {}), planId };
    const { job } = await createJob(jobType, params, { createdBy: actorUserId });
    await enqueueItems(job.id, customerIds);
    await query(`
        INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,$2,'plan',$3,$4::jsonb)
    `, [actorUserId, auditAction, planId, JSON.stringify({ jobId: job.id, affected: customerIds.length, params })]);
    return getJob(job.id);
}

// Full Jellyfin reconciliation. Use this only when the plan change is meant
// to re-apply the Jellyfin account policy (including an intentional Libraries
// card change). Request-service policy is reconciled by the same worker item.
async function queuePlanReconciliation(planId, actorUserId, jobParams = {}) {
    return queuePlanCustomerJob('plan_reconcile', planId, actorUserId, 'admin.plan.reconcile_queued', jobParams);
}

// Discord-only fanout for plan role mapping changes. This deliberately avoids
// touching Jellyfin account policy just because an operator changed a Discord role.
async function queuePlanDiscordReconciliation(planId, actorUserId, jobParams = {}) {
    return queuePlanCustomerJob('discord_plan_reconcile', planId, actorUserId, 'admin.plan.discord_reconcile_queued', jobParams);
}

// Request-only fanout for settings that do not need to touch Jellyfin account
// policy at all (for example request quotas or a Stremio household change).
async function queuePlanRequestReconciliation(planId, actorUserId) {
    return queuePlanCustomerJob('request_plan_reconcile', planId, actorUserId, 'admin.plan.request_reconcile_queued');
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
    queuePlanReconciliation,
    queuePlanDiscordReconciliation,
    queuePlanRequestReconciliation
};