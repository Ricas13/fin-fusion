'use strict';

require('dotenv').config();
const crypto = require('crypto');
const pkg = require('../package.json');
const { query, getPool } = require('../src/db');
const { automationConnectionBudget } = require('../src/security/database-connection-budget');
const { withMaintenanceSharedLock } = require('../src/security/maintenance-lock');
const jobHealth = require('../src/automation/job-health');
const jobRegistry = require('../src/automation/jobs');
const providerSettings = require('../src/payments/provider-settings');
const requestSettings = require('../src/integrations/request-service-settings');
const emailSettings = require('../src/integrations/email-settings');

const POLL_MS = Math.max(5000, Math.min(60000, Number(process.env.AUTOMATION_WORKER_POLL_MS || 15000)));
const DB_POOL_SIZE = Math.max(1, Math.min(50, Number(process.env.DB_POOL_SIZE || 6)));
const REQUESTED_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.AUTOMATION_WORKER_CONCURRENCY || 3)));
const DB_CONTROL_HEADROOM = DB_POOL_SIZE >= 3 ? 2 : 0;
const MAX_CONCURRENCY = Math.max(1, Math.min(REQUESTED_CONCURRENCY, DB_POOL_SIZE - DB_CONTROL_HEADROOM));
const CONNECTION_BUDGET = automationConnectionBudget();
const HEARTBEAT_MS = Math.max(5000, Math.min(60000, Number(process.env.AUTOMATION_WORKER_HEARTBEAT_MS || 15000)));
const INSTANCE_ID = String(process.env.HOSTNAME || `automation-${crypto.randomUUID()}`).slice(0, 200);
const COMMIT_SHA = String(process.env.COMMIT_SHA || process.env.GITHUB_SHA || '').slice(0, 80) || null;
const DEFAULT_JOB_INTERVALS=Object.freeze({free_places_digest:30,data_retention:3600,stremio_external_tokens:300,stremio_media_index:10800});
let stopping = false;
let running = new Set();
let heartbeatTimer = null;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function ensureRows() {
    for (const jobKey of jobRegistry.names()) {
        const interval=Number(DEFAULT_JOB_INTERVALS[jobKey]||300);
        await query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at)
            VALUES($1,TRUE,$2,NOW()) ON CONFLICT(job_key) DO NOTHING`, [jobKey,interval]);
    }
}

async function heartbeat({ draining = false } = {}) {
    await query(`INSERT INTO operational_worker_state(worker_key,instance_id,version,commit_sha,started_at,last_heartbeat_at,draining_at,metadata,updated_at)
        VALUES('automation',$1,$2,$3,NOW(),NOW(),CASE WHEN $4 THEN NOW() ELSE NULL END,$5::jsonb,NOW())
        ON CONFLICT(worker_key,instance_id) DO UPDATE SET version=EXCLUDED.version,
            commit_sha=EXCLUDED.commit_sha,last_heartbeat_at=NOW(),draining_at=CASE WHEN $4 THEN COALESCE(operational_worker_state.draining_at,NOW()) ELSE NULL END,
            metadata=EXCLUDED.metadata,updated_at=NOW()`,
    [INSTANCE_ID, pkg.version || null, COMMIT_SHA, Boolean(draining), JSON.stringify({
        pollMs: POLL_MS,
        heartbeatMs: HEARTBEAT_MS,
        concurrency: MAX_CONCURRENCY,
        requestedConcurrency: REQUESTED_CONCURRENCY,
        dbPoolSize: DB_POOL_SIZE,
        dbControlHeadroom: DB_CONTROL_HEADROOM,
        dbConnectionBudget: {
            roleLimit: CONNECTION_BUDGET.roleLimit,
            primaryPoolMax: CONNECTION_BUDGET.primaryPoolMax,
            maintenanceLockPoolMax: CONNECTION_BUDGET.maintenanceLockPoolMax,
            reconciliationMax: CONNECTION_BUDGET.reconciliationMax,
            healthcheckReserve: CONNECTION_BUDGET.healthcheckReserve,
            totalReserved: CONNECTION_BUDGET.totalReserved,
            spare: CONNECTION_BUDGET.spare
        },
        hostname: process.env.HOSTNAME || null,
        containerId: process.env.CONTAINER_ID || null,
        containerName: process.env.CONTAINER_NAME || null
    })]);
}

async function dueJobs() {
    const result = await query(`SELECT job_key,force_run_requested FROM automation_job_state
        WHERE (enabled=TRUE AND (next_run_at IS NULL OR next_run_at<=NOW())) OR force_run_requested=TRUE
        ORDER BY force_run_requested DESC,COALESCE(next_run_at,'1970-01-01'::timestamptz),job_key`);
    return result.rows.filter(row => jobRegistry.jobs[row.job_key]);
}

async function runOne(row) {
    const jobKey = row.job_key;
    try {
        const guarded = await withMaintenanceSharedLock(
            () => jobHealth.runSingleton(jobKey, () => jobRegistry.run(jobKey), { force: Boolean(row.force_run_requested) }),
            { skipIfBusy: true }
        );
        if (guarded?.skipped && guarded?.reason === 'database_maintenance') return;
        const result = guarded;
        if (result?.skipped) return;
        const value = result?.value || {};
        const failed = Number(value.failed || value.failures || value.errors || 0);
        const processed = Number(value.processed ?? value.total ?? value.attempted ?? 0);
        if (result?.degraded) {
            console.warn(`automation ${jobKey}: outcome=degraded processed=${processed} failed=${failed} retrySeconds=${result.retrySeconds}`);
        } else if (processed || failed) {
            console.log(`automation ${jobKey}: outcome=success processed=${processed} failed=${failed}`);
        }
    } catch (error) {
        const retry = Number(error.automationRetrySeconds || 0);
        console.error(`automation ${jobKey} failed${retry ? `; retry in ${retry}s` : ''}:`, error.message);
    }
}

async function runBatch(rows) {
    let index = 0;
    const workers = Array.from({ length: Math.min(MAX_CONCURRENCY, rows.length) }, async () => {
        while (!stopping) {
            const row = rows[index++];
            if (!row) break;
            const promise = runOne(row);
            running.add(promise);
            try { await promise; } finally { running.delete(promise); }
        }
    });
    await Promise.all(workers);
}

async function loop() {
    await Promise.all([
        providerSettings.ensureLoaded(),
        requestSettings.ensureLoaded().catch(error => {
            console.warn('Automation request-service settings refresh failed during startup:', error.message);
        }),
        emailSettings.ensureLoaded?.() || Promise.resolve()
    ]);
    await ensureRows();
    await heartbeat();
    heartbeatTimer = setInterval(() => heartbeat({ draining: stopping }).catch(error => console.error('Automation heartbeat failed:', error.message)), HEARTBEAT_MS);
    heartbeatTimer.unref?.();
    console.log(
        `CAPTAiNFiN automation worker ready; poll=${POLL_MS}ms `
        + `concurrency=${MAX_CONCURRENCY}/${REQUESTED_CONCURRENCY} dbPool=${DB_POOL_SIZE} `
        + `dbBudget=${CONNECTION_BUDGET.totalReserved}/${CONNECTION_BUDGET.roleLimit} `
        + `(maintenance=${CONNECTION_BUDGET.maintenanceLockPoolMax}, reconcile=${CONNECTION_BUDGET.reconciliationMax})`
    );
    while (!stopping) {
        try {
            await heartbeat();
            const due = await dueJobs();
            if (due.length) await runBatch(due);
        } catch (error) {
            console.error('Automation scheduler iteration failed:', error.message);
        }
        if (!stopping) await sleep(POLL_MS);
    }
}

async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Automation worker draining (${signal}); active=${running.size}`);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await heartbeat({ draining: true }).catch(error => {
        console.warn('Unable to publish final automation draining heartbeat:', error.message);
    });
    if (running.size) await Promise.allSettled([...running]);
    await query(`UPDATE operational_worker_state SET last_heartbeat_at=NOW(),draining_at=COALESCE(draining_at,NOW()),updated_at=NOW() WHERE worker_key='automation' AND instance_id=$1`, [INSTANCE_ID]).catch(error => {
        console.warn('Unable to persist final automation draining state:', error.message);
    });
    try { await getPool().end(); } catch (error) {
        console.warn('Automation database pool close failed:', error.message);
    }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop().catch(async error => {
    console.error('Automation worker fatal error:', error);
    process.exitCode = 1;
    await shutdown('fatal');
});
