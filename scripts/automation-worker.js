'use strict';

require('dotenv').config();
const { query, getPool } = require('../src/db');
const jobHealth = require('../src/automation/job-health');
const jobRegistry = require('../src/automation/jobs');
const providerSettings = require('../src/payments/provider-settings');
const requestSettings = require('../src/integrations/request-service-settings');
const emailSettings = require('../src/integrations/email-settings');

const POLL_MS = Math.max(5000, Math.min(60000, Number(process.env.AUTOMATION_WORKER_POLL_MS || 15000)));
let stopping = false;

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function ensureRows() {
    for (const jobKey of jobRegistry.names()) {
        await query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at)
            VALUES($1,TRUE,300,NOW()) ON CONFLICT(job_key) DO NOTHING`, [jobKey]);
    }
}

async function dueJobs() {
    const result = await query(`SELECT job_key FROM automation_job_state
        WHERE enabled=TRUE AND (next_run_at IS NULL OR next_run_at<=NOW())
        ORDER BY COALESCE(next_run_at,'1970-01-01'::timestamptz),job_key`);
    return result.rows.map(row => row.job_key).filter(key => jobRegistry.jobs[key]);
}

async function runOne(jobKey) {
    try {
        const result = await jobHealth.runSingleton(jobKey, () => jobRegistry.run(jobKey));
        if (result?.skipped) return;
        const value = result?.value || {};
        const failed = Number(value.failed || 0);
        const processed = Number(value.processed ?? value.total ?? value.attempted ?? 0);
        if (processed || failed) console.log(`automation ${jobKey}: processed=${processed} failed=${failed}`);
    } catch (error) {
        console.error(`automation ${jobKey} failed:`, error.message);
    }
}

async function loop() {
    await Promise.all([
        providerSettings.ensureLoaded(),
        requestSettings.ensureLoaded().catch(() => {}),
        emailSettings.ensureLoaded?.() || Promise.resolve()
    ]);
    await ensureRows();
    console.log(`CAPTaINFiN automation worker ready; poll=${POLL_MS}ms`);
    while (!stopping) {
        try {
            const due = await dueJobs();
            for (const jobKey of due) {
                if (stopping) break;
                await runOne(jobKey);
            }
        } catch (error) {
            console.error('Automation scheduler iteration failed:', error.message);
        }
        if (!stopping) await sleep(POLL_MS);
    }
}

async function shutdown(signal) {
    if (stopping) return;
    stopping = true;
    console.log(`Automation worker stopping (${signal})`);
    try { await getPool().end(); } catch (_) {}
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

loop().catch(async error => {
    console.error('Automation worker fatal error:', error);
    process.exitCode = 1;
    await shutdown('fatal');
});
