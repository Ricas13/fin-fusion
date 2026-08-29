'use strict';

const MINUTE_MS = 60 * 1000;
const PROVISIONING_WARNING_FAILURES = 3;
const PROVISIONING_CRITICAL_FAILURES = 6;
const PROVISIONING_BLOCKED_GRACE_MS = 5 * MINUTE_MS;
const JOB_WARNING_FAILURES = 3;
const JOB_CRITICAL_FAILURES = 6;
const WORKER_WARNING_MS = 5 * MINUTE_MS;
const WORKER_CRITICAL_MS = 15 * MINUTE_MS;
const CORE_AUTOMATION_JOBS = new Set(['entitlements', 'billing', 'plan_changes', 'health']);
const REQUIRED_ENABLED_JOBS = new Set(['payment_events', 'plan_changes']);

function timestamp(value) {
    if (!value) return 0;
    const ms = new Date(value).getTime();
    return Number.isFinite(ms) ? ms : 0;
}

function provisioningDecision(row, now = Date.now()) {
    const status = String(row?.status || '').toLowerCase();
    if (!['failed', 'blocked'].includes(status)) return { visible: false, automatic: true, severity: null };
    const action = String(row?.last_action || row?.action || '').toLowerCase();
    const failures = Math.max(0, Number(row?.consecutive_failures || 0));
    // When available, measure from the beginning of the current unresolved
    // streak rather than the most recent retry. Otherwise each automatic retry
    // would reset the blocked grace period forever.
    const problemStarted = timestamp(row?.problem_started_at || row?.last_attempt_at || row?.run_started_at || row?.updated_at);
    const ageMs = problemStarted ? Math.max(0, now - problemStarted) : Infinity;

    // Access removal is safety-sensitive: a failed disable can leave service
    // available after CAPTAiNFiN intended to revoke it, so do not hide it behind
    // the normal retry tolerance.
    if (action === 'disable') {
        return { visible: true, automatic: false, severity: 'critical', failures, ageMs, reason: 'access_removal_failed' };
    }

    if (status === 'blocked') {
        // Blocked usually means a missing server/plan/source prerequisite. Give
        // a fresh failure a short window for fleet/source state to recover, then
        // ask an operator to inspect the prerequisite rather than retry forever.
        if (ageMs < PROVISIONING_BLOCKED_GRACE_MS) {
            return { visible: false, automatic: true, severity: null, failures, ageMs, reason: 'blocked_grace' };
        }
        return { visible: true, automatic: false, severity: 'warning', failures, ageMs, reason: 'blocked' };
    }

    // Ordinary failed reconciles already have 1/2/5/10/30/60 minute automatic
    // retry backoff. The first two misses are telemetry, not operator work.
    if (failures < PROVISIONING_WARNING_FAILURES) {
        return { visible: false, automatic: true, severity: null, failures, ageMs, reason: 'automatic_retry' };
    }
    return {
        visible: true,
        automatic: false,
        severity: failures >= PROVISIONING_CRITICAL_FAILURES ? 'critical' : 'warning',
        failures,
        ageMs,
        reason: failures >= PROVISIONING_CRITICAL_FAILURES ? 'retry_exhausted' : 'persistent_failure'
    };
}

function jobDecision(row, state) {
    const health = String(state || '').toLowerCase();
    const jobKey = String(row?.job_key || '');
    if (health === 'disabled' && REQUIRED_ENABLED_JOBS.has(jobKey)) return { visible: true, severity: 'critical', reason: 'disabled', failures: 0 };
    if (health === 'stale') return { visible: true, severity: 'warning', reason: 'stale' };
    if (!['failed', 'degraded'].includes(health)) return { visible: false, severity: null };
    const failures = Math.max(0, Number(row?.consecutive_failures || 0));
    if (failures < JOB_WARNING_FAILURES) return { visible: false, severity: null, failures, reason: 'automatic_retry' };
    const core = CORE_AUTOMATION_JOBS.has(jobKey);
    return {
        visible: true,
        severity: core && failures >= JOB_CRITICAL_FAILURES ? 'critical' : 'warning',
        failures,
        reason: health
    };
}

function workerDecision(row, now = Date.now(), appUptimeSeconds = process.uptime()) {
    if (!row) {
        if (Number(appUptimeSeconds) < 5 * 60) return { visible: false, severity: null, reason: 'startup_grace' };
        return {
            visible: true,
            severity: Number(appUptimeSeconds) >= 15 * 60 ? 'critical' : 'warning',
            ageMs: Number(appUptimeSeconds) * 1000,
            reason: 'missing'
        };
    }
    if (row.draining_at) return { visible: false, severity: null, reason: 'draining' };
    const last = timestamp(row.last_heartbeat_at);
    const ageMs = last ? Math.max(0, now - last) : Infinity;
    if (ageMs < WORKER_WARNING_MS) return { visible: false, severity: null, ageMs, reason: 'within_tolerance' };
    return {
        visible: true,
        severity: ageMs >= WORKER_CRITICAL_MS ? 'critical' : 'warning',
        ageMs,
        reason: 'stale'
    };
}

function serverDecision(row, healthJob) {
    const status = String(row?.health_status || '').toLowerCase();
    // Degraded is diagnostic state from an initial miss. Needs Attention waits
    // for repeated fleet-health failures before interrupting the operator.
    if (status !== 'offline') return { visible: false, severity: null, reason: status || 'unknown' };
    const failures = Math.max(0, Number(healthJob?.consecutive_failures || 0));
    if (healthJob && failures < JOB_WARNING_FAILURES) {
        return { visible: false, severity: null, failures, reason: 'fleet_retrying' };
    }
    return {
        visible: true,
        severity: failures >= JOB_CRITICAL_FAILURES ? 'critical' : 'warning',
        failures,
        reason: 'offline'
    };
}

function paymentDecision(row) {
    const type = String(row?.incident_type || '').toLowerCase();
    const scope = String(row?.scope || '').toLowerCase();
    const unresolvedIdentity = scope === 'unresolved' || !row?.customer_id;
    if (type === 'dispute' || type === 'chargeback') {
        return { visible: true, severity: 'critical', reason: type };
    }
    // Refunds, mapped renewal failures and mapped checkout completions are
    // provider/lifecycle history. Surface them only when CAPTAiNFiN cannot
    // safely identify the customer or finish checkout reconciliation.
    if (type === 'refund') return { visible: unresolvedIdentity, severity: unresolvedIdentity ? 'warning' : null, reason: unresolvedIdentity ? 'unresolved_identity' : 'history_only' };
    if (type === 'failed_renewal') return { visible: unresolvedIdentity, severity: unresolvedIdentity ? 'warning' : null, reason: unresolvedIdentity ? 'unresolved_identity' : 'provider_retry' };
    if (type === 'checkout_completion') return { visible: unresolvedIdentity, severity: unresolvedIdentity ? 'critical' : null, reason: unresolvedIdentity ? 'checkout_reconciliation' : 'history_only' };
    if (unresolvedIdentity) return { visible: true, severity: 'warning', reason: 'unresolved_identity' };
    return { visible: false, severity: null, reason: 'history_only' };
}

module.exports = {
    MINUTE_MS,
    PROVISIONING_WARNING_FAILURES,
    PROVISIONING_CRITICAL_FAILURES,
    PROVISIONING_BLOCKED_GRACE_MS,
    JOB_WARNING_FAILURES,
    JOB_CRITICAL_FAILURES,
    WORKER_WARNING_MS,
    WORKER_CRITICAL_MS,
    CORE_AUTOMATION_JOBS,
    REQUIRED_ENABLED_JOBS,
    timestamp,
    provisioningDecision,
    jobDecision,
    workerDecision,
    serverDecision,
    paymentDecision
};