'use strict';

const { query, getPool } = require('../db');

function countFromResult(result) {
    if (typeof result === 'number') return result;
    if (Array.isArray(result)) return result.length;
    if (!result || typeof result !== 'object') return null;
    for (const key of ['processed','attempted','total','succeeded','created']) {
        if (Number.isFinite(Number(result[key]))) return Number(result[key]);
    }
    return null;
}

async function config(jobKey, fallbackMs) {
    const result = await query('SELECT * FROM automation_job_state WHERE job_key=$1', [jobKey]);
    if (!result.rowCount) return { enabled: true, intervalMs: fallbackMs };
    return { ...result.rows[0], intervalMs: Number(result.rows[0].interval_seconds) * 1000 };
}

async function intervalMs(jobKey, fallbackMs) {
    const row = await config(jobKey, fallbackMs);
    return row.enabled === false ? Math.max(60000, row.intervalMs || fallbackMs) : (row.intervalMs || fallbackMs);
}

async function runSingleton(jobKey, fn, { force = false } = {}) {
    const pool = getPool();
    const client = await pool.connect();
    const startedAt = Date.now();
    let locked = false;
    try {
        const cfg = await client.query('SELECT * FROM automation_job_state WHERE job_key=$1', [jobKey]);
        if (cfg.rowCount && cfg.rows[0].enabled === false && !force) return { skipped: true, reason: 'disabled' };
        const lock = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`, [`captainfin:${jobKey}`]);
        locked = Boolean(lock.rows[0]?.locked);
        if (!locked) return { skipped: true, reason: 'already_running' };
        await client.query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,last_started_at,force_run_requested,updated_at)
            VALUES($1,TRUE,300,NOW(),FALSE,NOW()) ON CONFLICT(job_key) DO UPDATE
            SET last_started_at=NOW(),force_run_requested=FALSE,updated_at=NOW()`, [jobKey]);
        try {
            const value = await fn();
            const duration = Date.now() - startedAt;
            const processed = countFromResult(value);
            await client.query(`UPDATE automation_job_state SET last_success_at=NOW(),last_error=NULL,last_duration_ms=$2,
                last_processed_count=$3,consecutive_failures=0,next_run_at=NOW()+(interval_seconds*INTERVAL '1 second'),updated_at=NOW()
                WHERE job_key=$1`, [jobKey, duration, processed]);
            return { ok: true, value };
        } catch (error) {
            const duration = Date.now() - startedAt;
            await client.query(`UPDATE automation_job_state SET last_error=$2,last_duration_ms=$3,
                consecutive_failures=consecutive_failures+1,next_run_at=NOW()+(interval_seconds*INTERVAL '1 second'),updated_at=NOW()
                WHERE job_key=$1`, [jobKey, String(error?.message || error).slice(0,1500), duration]);
            throw error;
        }
    } finally {
        if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`captainfin:${jobKey}`]).catch(() => {});
        client.release();
    }
}

async function list() {
    const result = await query('SELECT * FROM automation_job_state ORDER BY job_key');
    return result.rows;
}

async function update(jobKey, { enabled, intervalSeconds }) {
    const seconds = Math.max(30, Math.min(86400, Number(intervalSeconds) || 300));
    const result = await query(`UPDATE automation_job_state SET enabled=$2,interval_seconds=$3,
        next_run_at=CASE WHEN $2 THEN COALESCE(next_run_at,NOW()) ELSE next_run_at END,updated_at=NOW()
        WHERE job_key=$1 RETURNING *`, [jobKey, Boolean(enabled), seconds]);
    if (!result.rowCount) throw new Error('Automation job not found.');
    return result.rows[0];
}

async function requestRun(jobKey) {
    const result = await query(`UPDATE automation_job_state
        SET next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()
        WHERE job_key=$1 RETURNING *`, [jobKey]);
    if (!result.rowCount) throw new Error('Automation job not found.');
    return result.rows[0];
}

function healthState(row, now = Date.now()) {
    if (!row) return 'missing';
    if (row.enabled === false && !row.force_run_requested) return 'disabled';
    if (row.last_error) return 'failed';
    if (row.last_started_at && !row.last_success_at) return 'running';
    if (!row.last_started_at && !row.last_success_at) return 'never_run';
    const intervalMs = Math.max(30000, Number(row.interval_seconds || 300) * 1000);
    const successAt = row.last_success_at ? new Date(row.last_success_at).getTime() : 0;
    if (!successAt || now - successAt > Math.max(intervalMs * 3, 15 * 60 * 1000)) return 'stale';
    return 'healthy';
}

module.exports = { config, intervalMs, runSingleton, list, update, requestRun, countFromResult, healthState };
