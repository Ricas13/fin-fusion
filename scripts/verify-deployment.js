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

            const workers = await query(`
                SELECT worker_key,instance_id,last_heartbeat_at,
                       EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int AS age
                FROM operational_worker_state WHERE worker_key IN ('automation','activity')
            `);
            const byKey = new Map(workers.rows.map(row => [row.worker_key, row]));
            const automationWorker = byKey.get('automation');
            add('automation worker', automationWorker && Number(automationWorker.age) < 90,
                automationWorker ? `instance=${automationWorker.instance_id} heartbeat_age=${automationWorker.age}s` : 'no heartbeat');
            const activityWorker = byKey.get('activity');
            add('activity worker', activityWorker && Number(activityWorker.age) < 120,
                activityWorker ? `instance=${activityWorker.instance_id} heartbeat_age=${activityWorker.age}s` : 'no heartbeat');

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
            const critical = new Set(['billing', 'entitlements', 'plan_changes', 'customer_inactivity']);
            const bad = jobs.filter(job => critical.has(job.job_key) && ['failed', 'stale', 'missing'].includes(jobHealth.healthState(job)));
            const inactivityJob = jobs.find(job => job.job_key === 'customer_inactivity');
            add('Free Server lifecycle job', Boolean(inactivityJob?.enabled), inactivityJob ? `state=${jobHealth.healthState(inactivityJob)} next=${inactivityJob.next_run_at || 'pending'}` : 'job row missing');
            add('critical automation jobs', bad.length === 0, bad.map(job => `${job.job_key}:${jobHealth.healthState(job)}`).join(', '));

            const lifecycleTable = (await query(`SELECT to_regclass('public.jellyfin_account_lifecycle') AS table_name`)).rows[0]?.table_name;
            add('Free Server lifecycle ledger', Boolean(lifecycleTable), lifecycleTable || 'table missing');

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

        for (const check of checks) console.log(`${check.ok ? 'PASS' : 'FAIL'}  ${check.name}${check.detail ? ` — ${check.detail}` : ''}`);
        const failed = checks.filter(check => !check.ok);
        if (failed.length) {
            process.exitCode = 1;
            console.error(`Deployment verification failed: ${failed.length} blocker(s).`);
        } else console.log('Deployment verification passed.');
    } finally {
        await getPool().end().catch(() => {});
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
