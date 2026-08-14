'use strict';

// DB-backed regression tests for the bulk-job framework and plan-change
// reconciliation fanout (src/platform/bulk-jobs.js, src/jellyfin/provisioning.js
// reconciliation-status tracking). Requires a live Postgres instance --
// matches the existing platform-smoke.js / auth-smoke.js convention and
// only runs where DATABASE_URL is configured (this repo's CI), not in a
// sandbox with no `pg` module available.

require('dotenv').config();
const crypto = require('crypto');
const { getPool, query } = require('../src/db');
const bulkJobs = require('../src/platform/bulk-jobs');
const provisioning = require('../src/jellyfin/provisioning');

async function main() {
    const suffix = crypto.randomBytes(4).toString('hex');

    const plan = await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
        VALUES($1,'Bulk smoke plan','direct','custom',30,0,'USD',1,'premium',TRUE,TRUE)
        RETURNING id
    `, [`bulk-smoke-plan-${suffix}`]);
    const planId = plan.rows[0].id;

    const customer = await query(
        `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
        [`Bulk Smoke ${suffix}`, `bulk-smoke-${suffix}@example.invalid`]
    );
    const customerId = customer.rows[0].id;

    await query(`
        INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end)
        VALUES($1,$2,'active','manual',NOW(),NOW()+INTERVAL '30 days')
    `, [customerId, planId]);

    // #7 / #8 a plan's Jellyfin/library settings change queues affected
    // active customers for reconciliation instead of blocking the request --
    // both admin-plans.js's Jellyfin-tab save and admin-plan-libraries.js's
    // library save route through this same queuePlanReconciliation call.
    const planJob = await bulkJobs.queuePlanReconciliation(planId, null);
    if (!planJob) throw new Error('queuePlanReconciliation should have queued a job for an active subscriber');
    if (Number(planJob.total_items) < 1) throw new Error('Queued job should include the affected customer');
    const planJobItems = await bulkJobs.listJobItems(planJob.id);
    if (!planJobItems.some(item => item.customer_id === customerId)) {
        throw new Error('Affected customer missing from queued plan-reconciliation job items');
    }

    // A plan with zero active subscribers must not queue an empty job.
    const emptyPlan = await query(`
        INSERT INTO plans(code,name,audience,billing_interval,duration_days,price_minor,currency,streams,server_class,active,visible)
        VALUES($1,'Bulk smoke empty plan','direct','custom',30,0,'USD',1,'premium',TRUE,TRUE)
        RETURNING id
    `, [`bulk-smoke-empty-plan-${suffix}`]);
    const noJob = await bulkJobs.queuePlanReconciliation(emptyPlan.rows[0].id, null);
    if (noJob) throw new Error('A plan with no active subscribers must not queue a reconciliation job');

    // #11 reconciliation status writes for the same account are idempotent --
    // never a duplicate row, attempt_count accumulates, status reflects the
    // most recent write.
    const server = await query(`
        INSERT INTO jellyfin_servers(name,slug,server_class,base_url,api_key_encrypted)
        VALUES($1,$2,'premium','https://jellyfin-smoke.invalid','jf1:smoke')
        RETURNING id
    `, [`Bulk smoke server ${suffix}`, `bulk-smoke-server-${suffix}`]);
    const serverId = server.rows[0].id;
    const account = await query(`
        INSERT INTO jellyfin_accounts(customer_id,server_id,jellyfin_user_id,jellyfin_username)
        VALUES($1,$2,$3,$4) RETURNING id
    `, [customerId, serverId, `smoke-user-${suffix}`, `smoke-user-${suffix}`]);
    const accountId = account.rows[0].id;
    await provisioning.upsertReconciliationStatus(accountId, customerId, 'failed', 'first attempt');
    await provisioning.upsertReconciliationStatus(accountId, customerId, 'successful', null);
    const reconRows = await query('SELECT * FROM jellyfin_policy_reconciliation WHERE jellyfin_account_id=$1', [accountId]);
    if (reconRows.rowCount !== 1) throw new Error('Reconciliation status upsert must never create duplicate rows for the same account');
    if (reconRows.rows[0].status !== 'successful') throw new Error('Reconciliation status must reflect the most recent write');
    if (Number(reconRows.rows[0].attempt_count) !== 2) throw new Error('attempt_count must accumulate across repeated writes, not reset');

    // #12 duplicate bulk-job submission (same idempotency key) must not
    // create a second job or double-enqueue/re-apply items.
    const idKey = `smoke-idem-${suffix}`;
    const first = await bulkJobs.createJob('reconcile', {}, { createdBy: null, idempotencyKey: idKey });
    await bulkJobs.enqueueItems(first.job.id, [customerId]);
    const second = await bulkJobs.createJob('reconcile', {}, { createdBy: null, idempotencyKey: idKey });
    if (!second.reused) throw new Error('Duplicate submission with the same idempotency key must reuse the existing job, not create a new one');
    if (second.job.id !== first.job.id) throw new Error('A reused job must be the exact same job as the original submission');
    const dupInsertCount = await bulkJobs.enqueueItems(second.job.id, [customerId]);
    if (dupInsertCount !== 0) throw new Error('Re-enqueueing the same customer on a reused job must not insert a duplicate item');
    const itemCountAfterDup = await query('SELECT COUNT(*)::int n FROM background_job_items WHERE job_id=$1', [first.job.id]);
    if (Number(itemCountAfterDup.rows[0].n) !== 1) throw new Error('Duplicate submission must not result in the mutation being queued twice');

    // #13 retrying failed items must never touch an item that already
    // succeeded -- only items currently in 'failed' status are reset.
    const retryJob = await bulkJobs.createJob('reconcile', {});
    const customer2 = await query(
        `INSERT INTO customers(display_name,email) VALUES($1,$2) RETURNING id`,
        [`Bulk Smoke 2 ${suffix}`, `bulk-smoke-2-${suffix}@example.invalid`]
    );
    const customer2Id = customer2.rows[0].id;
    await bulkJobs.enqueueItems(retryJob.job.id, [customerId, customer2Id]);
    await query(`UPDATE background_job_items SET status='succeeded' WHERE job_id=$1 AND customer_id=$2`, [retryJob.job.id, customerId]);
    await query(`UPDATE background_job_items SET status='failed',attempt_count=1,last_error='boom' WHERE job_id=$1 AND customer_id=$2`, [retryJob.job.id, customer2Id]);
    const retriedCount = await bulkJobs.retryFailedItems(retryJob.job.id, null);
    if (retriedCount !== 1) throw new Error('retryFailedItems should only reset the one item that was actually failed');
    const afterRetry = await query('SELECT customer_id,status FROM background_job_items WHERE job_id=$1', [retryJob.job.id]);
    const succeededRow = afterRetry.rows.find(row => row.customer_id === customerId);
    const retriedRow = afterRetry.rows.find(row => row.customer_id === customer2Id);
    if (!succeededRow || succeededRow.status !== 'succeeded') throw new Error('Retry must never rerun an item that already succeeded');
    if (!retriedRow || retriedRow.status !== 'pending') throw new Error('Retry must reset a failed item back to pending for reprocessing');

    // #15 a reseller must never be able to view another reseller's bulk-job
    // results, even with a job id they somehow obtained.
    const resellerUser = await query(
        `INSERT INTO app_users(username,password_hash,role) VALUES($1,'x','reseller') RETURNING id`,
        [`bulk-smoke-reseller-${suffix}`]
    );
    const reseller = await query('INSERT INTO resellers(user_id) VALUES($1) RETURNING id', [resellerUser.rows[0].id]);
    const resellerId = reseller.rows[0].id;
    const otherResellerUser = await query(
        `INSERT INTO app_users(username,password_hash,role) VALUES($1,'x','reseller') RETURNING id`,
        [`bulk-smoke-reseller2-${suffix}`]
    );
    const otherReseller = await query('INSERT INTO resellers(user_id) VALUES($1) RETURNING id', [otherResellerUser.rows[0].id]);

    const scopedJob = await bulkJobs.createJob('reconcile', {}, { createdBy: null, resellerScope: resellerId });
    const ownResult = await bulkJobs.getJobForActor(scopedJob.job.id, { isReseller: true, resellerId });
    if (!ownResult) throw new Error('A reseller must be able to view their own scoped job');
    const foreignResult = await bulkJobs.getJobForActor(scopedJob.job.id, { isReseller: true, resellerId: otherReseller.rows[0].id });
    if (foreignResult) throw new Error("A reseller must never be able to view another reseller's job results");
    const adminResult = await bulkJobs.getJobForActor(scopedJob.job.id, null);
    if (!adminResult) throw new Error('An admin (no reseller scope) must still be able to view any job');

    console.log('Bulk jobs smoke test passed.');
}

main()
    .catch(error => { console.error(error); process.exitCode = 1; })
    .finally(async () => { try { await getPool().end(); } catch (_) {} });
