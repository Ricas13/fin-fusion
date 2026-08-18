'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { query, getPool } = require('../src/db');
const runtimeSettings = require('../src/platform/runtime-settings');
const jobHealth = require('../src/automation/job-health');

async function main() {
    const checks = [];
    const add = (name, ok, detail = '') => checks.push({ name, ok: Boolean(ok), detail: String(detail || '') });

    try {
        try {
            await query('SELECT 1');
            add('database', true);
        } catch (error) {
            add('database', false, error.message);
        }

        if (checks.at(-1)?.ok) {
            const files = fs.readdirSync(path.join(__dirname, '..', 'db', 'migrations')).filter(file => file.endsWith('.sql')).sort();
            const expected = files.at(-1);
            const applied = (await query('SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1')).rows[0]?.filename;
            add('migrations', applied === expected, `applied=${applied || 'none'} expected=${expected}`);

            try {
                await runtimeSettings.ensureLoaded();
                add('runtime settings', true, runtimeSettings.siteName());
            } catch (error) {
                add('runtime settings', false, error.message);
            }

            const worker = (await query(`
                SELECT instance_id,last_heartbeat_at,
                       EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int AS age
                FROM operational_worker_state WHERE worker_key='automation'
            `)).rows[0];
            add('automation worker', worker && Number(worker.age) < 90,
                worker ? `instance=${worker.instance_id} heartbeat_age=${worker.age}s` : 'no heartbeat');

            const backupWorker = (await query(`
                SELECT instance_id,last_heartbeat_at,last_success_at,last_error,next_run_at,
                       EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int AS age
                FROM backup_worker_state WHERE worker_key='database_backup'
            `)).rows[0];
            const backupHealthy = backupWorker
                && Number(backupWorker.age) < 180
                && (!backupWorker.last_error || backupWorker.next_run_at === null);
            add('backup worker', backupHealthy,
                backupWorker
                    ? `instance=${backupWorker.instance_id} heartbeat_age=${backupWorker.age}s last_success=${backupWorker.last_success_at || 'never'}${backupWorker.last_error ? ` error=${backupWorker.last_error}` : ''}`
                    : 'no heartbeat');

            const jobs = await jobHealth.list();
            const critical = new Set(['billing', 'entitlements', 'plan_changes']);
            const bad = jobs.filter(job => critical.has(job.job_key) && ['failed', 'stale', 'missing'].includes(jobHealth.healthState(job)));
            add('critical automation jobs', bad.length === 0, bad.map(job => `${job.job_key}:${jobHealth.healthState(job)}`).join(', '));

            const fleet = await query(`
                SELECT COUNT(*)::int AS enabled,
                       COUNT(*) FILTER (
                           WHERE COALESCE(placement_mode,'active')='active'
                             AND health_status IN ('healthy','degraded')
                       )::int AS placement_ready
                FROM jellyfin_servers WHERE enabled=TRUE
            `);
            add('fleet', Number(fleet.rows[0].enabled) === 0 || Number(fleet.rows[0].placement_ready) > 0,
                `${fleet.rows[0].placement_ready}/${fleet.rows[0].enabled} placement-ready`);
        }

        for (const check of checks) {
            console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
        }
        const failed = checks.filter(check => !check.ok);
        if (failed.length) {
            process.exitCode = 1;
            console.error(`Deployment verification failed: ${failed.length} blocker(s).`);
        } else {
            console.log('Deployment verification passed.');
        }
    } finally {
        await getPool().end().catch(() => {});
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
