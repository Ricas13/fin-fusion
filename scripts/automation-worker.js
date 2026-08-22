'use strict';

require('dotenv').config();
const crypto = require('crypto');
const pkg = require('../package.json');
const { query, getPool } = require('../src/db');
const { withMaintenanceSharedLock } = require('../src/security/maintenance-lock');
const jobHealth = require('../src/automation/job-health');
const jobRegistry = require('../src/automation/jobs');
const providerSettings = require('../src/payments/provider-settings');
const requestSettings = require('../src/integrations/request-service-settings');
const emailSettings = require('../src/integrations/email-settings');

const POLL_MS = Math.max(5000, Math.min(60000, Number(process.env.AUTOMATION_WORKER_POLL_MS || 15000)));
const MAX_CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.AUTOMATION_WORKER_CONCURRENCY || 3)));
const HEARTBEAT_MS = Math.max(5000, Math.min(60000, Number(process.env.AUTOMATION_WORKER_HEARTBEAT_MS || 15000)));
const INSTANCE_ID = String(process.env.HOSTNAME || `automation-${crypto.randomUUID()}`).slice(0, 200);
const COMMIT_SHA = String(process.env.COMMIT_SHA || process.env.GITHUB_SHA || '').slice(0, 80) || null;
const DEFAULT_JOB_INTERVALS=Object.freeze({marketing_campaigns:60,stremio_external_tokens:300,stremio_media_index:10800});
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
        ON CONFLICT(worker_key) DO UPDATE SET instance_id=EXCLUDED.instance_id,version=EXCLUDED.version,
            commit_sha=EXCLUDED.commit_sha,last_heartbeat_at=NOW(),draining_at=CASE WHEN $4 THEN COALESCE(operational_worker_state.draining_at,NOW()) ELSE NULL END,
            metadata=EXCLUDED.metadata,updated_at=NOW()`,
    [INSTANCE_ID, pkg.version || null, COMMIT_SHA, Boolean(draining), JSON.stringify({ pollMs: POLL_MS, concurrency: MAX_CONCURRENCY })]);
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
        const failed = Number(value.failed || 0);
        const processed = Number(value.processed ?? value.total ?? value.attempted ?? 0);
        if (processed || failed) console.log(`automation ${jobKey}: processed=${processed} failed=${failed}`);
    } catch (error) {
        console.error(`automation ${jobKey} failed:`, error.message);
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
        requestSettings.ensureLoaded().catch(() => {}),
        emailSettings.ensureLoaded?.() || Promise.resolve()
    ]);
    await ensureRows();
    await heartbeat();
    heartbeatTimer = setInterval(() => heartbeat({ draining: stopping }).catch(error => console.error('Automation heartbeat failed:', error.message)), HEARTBEAT_MS);
    heartbeatTimer.unref?.();
    console.log(`CAPTAiNFiN automation worker ready; poll=${POLL_MS}ms concurrency=${MAX_CONCURRENCY}`);
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
    await heartbeat({ draining: true }).catch(() => {});
    if (running.size) await Promise.allSettled([...running]);
    await query(`UPDATE operational_worker_state SET last_heartbeat_at=NOW(),draining_at=COALESCE(draining_at,NOW()),updated_at=NOW() WHERE worker_key='automation' AND instance_id=$1`, [INSTANCE_ID]).catch(() => {});
    try { await getPool().end(); } catch (_) {}
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop().catch(async error => {
    console.error('Automation worker fatal error:', error);
    process.exitCode = 1;
    await shutdown('fatal');
});
