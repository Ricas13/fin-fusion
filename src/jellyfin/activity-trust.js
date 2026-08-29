'use strict';

const { query } = require('../db');

function intEnv(name, fallback, min, max) {
    const value = Number.parseInt(process.env[name] || '', 10);
    if (!Number.isFinite(value)) return fallback;
    return Math.max(min, Math.min(max, value));
}

function timing() {
    const pollSeconds = intEnv('STREAM_POLICY_POLL_SECONDS', 20, 15, 300);
    return {
        pollSeconds,
        slackSeconds: intEnv('STREAM_POLICY_POLL_SLACK_SECONDS', Math.max(10, Math.ceil(pollSeconds / 2)), 5, 120),
        workerMaxAgeSeconds: 120
    };
}

async function managedServerIds() {
    const result = await query(`
        SELECT DISTINCT ja.server_id
        FROM jellyfin_accounts ja
        JOIN jellyfin_servers js ON js.id=ja.server_id
        WHERE js.enabled=TRUE
          AND COALESCE(ja.account_purpose,'jellyfin')<>'stremio_internal'
        ORDER BY ja.server_id
    `);
    return result.rows.map(row => String(row.server_id));
}

async function recordCycle(serverIds, failures = [], at = new Date()) {
    const failed = new Map((failures || []).map(item => [String(item.serverId), String(item.error || 'poll failed').slice(0, 1000)]));
    for (const serverId of [...new Set((serverIds || []).map(String))]) {
        const error = failed.get(serverId) || null;
        await query(`
            INSERT INTO jellyfin_activity_poll_state(
                server_id,last_attempt_at,last_success_at,last_failure_at,last_error,updated_at
            ) VALUES($1,$2,$3,$4,$5,NOW())
            ON CONFLICT(server_id) DO UPDATE SET
                last_attempt_at=EXCLUDED.last_attempt_at,
                last_success_at=CASE WHEN EXCLUDED.last_error IS NULL THEN EXCLUDED.last_success_at ELSE jellyfin_activity_poll_state.last_success_at END,
                last_failure_at=CASE WHEN EXCLUDED.last_error IS NOT NULL THEN EXCLUDED.last_failure_at ELSE jellyfin_activity_poll_state.last_failure_at END,
                last_error=EXCLUDED.last_error,
                updated_at=NOW()
        `, [serverId, at, error ? null : at, error ? at : null, error]);
    }
}

async function workerTelemetry() {
    const result = await query(`
        SELECT EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at)) age_seconds
        FROM operational_worker_state
        WHERE worker_key='activity'
    `);
    const age = Number(result.rows[0]?.age_seconds ?? Infinity);
    return {
        ready: Number.isFinite(age) && age < 120,
        activityWorkerAgeSeconds: Number.isFinite(age) ? Math.round(age) : null
    };
}

function assessPoll(row, now = Date.now(), cfg = timing()) {
    const attempt = row?.last_attempt_at ? new Date(row.last_attempt_at) : null;
    const success = row?.last_success_at ? new Date(row.last_success_at) : null;
    const attemptMs = attempt && Number.isFinite(attempt.getTime()) ? attempt.getTime() : null;
    const successMs = success && Number.isFinite(success.getTime()) ? success.getTime() : null;
    const maxAgeSeconds = cfg.pollSeconds + cfg.slackSeconds;
    let reason = null;
    if (attemptMs == null) reason = 'never_polled';
    else if (successMs == null || successMs < attemptMs) reason = 'last_poll_failed';
    else if ((now - successMs) / 1000 > maxAgeSeconds) reason = 'poll_stale';
    return {
        ready: reason === null,
        reason,
        lastAttemptAt: attempt || null,
        lastSuccessAt: success || null,
        lastFailureAt: row?.last_failure_at || null,
        lastError: row?.last_error || null,
        pollAgeSeconds: successMs == null ? null : Math.max(0, Math.round((now - successMs) / 1000)),
        maxAgeSeconds
    };
}

async function serverTelemetry(serverIds, { now = Date.now() } = {}) {
    const ids = [...new Set((serverIds || []).filter(Boolean).map(String))];
    if (!ids.length) return {};
    const result = await query(`
        SELECT js.id server_id,aps.last_attempt_at,aps.last_success_at,aps.last_failure_at,aps.last_error
        FROM jellyfin_servers js
        LEFT JOIN jellyfin_activity_poll_state aps ON aps.server_id=js.id
        WHERE js.id=ANY($1::uuid[])
    `, [ids]);
    const byId = new Map(result.rows.map(row => [String(row.server_id), row]));
    const cfg = timing();
    return Object.fromEntries(ids.map(serverId => [serverId, assessPoll(byId.get(serverId) || null, now, cfg)]));
}

async function telemetryForServers(serverIds) {
    const worker = await workerTelemetry();
    const servers = await serverTelemetry(serverIds);
    const values = Object.values(servers);
    return {
        ready: Boolean(worker.ready && values.every(server => server.ready)),
        ...worker,
        targetServers: values.length,
        unsafeTargetServers: values.filter(server => !server.ready).length,
        servers
    };
}

module.exports = {
    timing,
    managedServerIds,
    recordCycle,
    workerTelemetry,
    assessPoll,
    serverTelemetry,
    telemetryForServers
};
