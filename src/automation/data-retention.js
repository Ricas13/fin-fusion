'use strict';

const { query } = require('../db');

const DEFAULT_POLICY = Object.freeze({
    enabled: true,
    batchSize: 500,
    classes: Object.freeze({
        playbackHistoryDays: 180,
        securityEventDays: 365,
        auditLogDays: 730,
        paymentEventDays: 365,
        providerOperationDays: 365,
        notificationHistoryDays: 90,
        networkEventDays: 90,
        streamPolicyEventDays: 90,
        provisioningRunDays: 180,
        downloadEventDays: 180,
        stremioAttributionDays: 180
    })
});

const RETENTION_CLASSES = Object.freeze([
    ['playback_history', 'playbackHistoryDays'],
    ['auth_events', 'securityEventDays'],
    ['audit_log', 'auditLogDays'],
    ['payment_events', 'paymentEventDays'],
    ['provider_operations', 'providerOperationDays'],
    ['notification_outbox', 'notificationHistoryDays'],
    ['access_network_events', 'networkEventDays'],
    ['stream_policy_events', 'streamPolicyEventDays'],
    ['provisioning_runs', 'provisioningRunDays'],
    ['customer_download_events', 'downloadEventDays'],
    ['stremio_stream_attribution', 'stremioAttributionDays']
]);

function boundedInteger(value, fallback, min, max) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, Math.floor(parsed))) : fallback;
}

async function policy() {
    const result = await query("SELECT setting_value FROM platform_settings WHERE setting_key='data_retention_v1'");
    const raw = result.rows[0]?.setting_value || {};
    const classes = raw.classes || {};
    const normalized = {};
    for (const [, key] of RETENTION_CLASSES) normalized[key] = boundedInteger(classes[key], DEFAULT_POLICY.classes[key], 1, 3650);
    return {
        enabled: raw.enabled !== false,
        batchSize: boundedInteger(raw.batchSize, DEFAULT_POLICY.batchSize, 1, 1000),
        classes: normalized
    };
}

async function run({ now = new Date() } = {}) {
    const configured = await policy();
    const leaseResult = await query('SELECT public.cleanup_expired_access_network_leases($1) AS deleted', [configured.batchSize]);
    const networkLeasesDeleted = Number(leaseResult.rows[0]?.deleted || 0);
    if (!configured.enabled) return { processed: networkLeasesDeleted, networkLeasesDeleted, retentionDisabled: true, classes: {} };

    const results = {};
    let processed = networkLeasesDeleted;
    for (const [dataClass, policyKey] of RETENTION_CLASSES) {
        const cutoff = new Date(now.getTime() - configured.classes[policyKey] * 86400000);
        const result = await query('SELECT public.run_data_retention_batch($1,$2,$3) AS deleted', [dataClass, cutoff, configured.batchSize]);
        const deleted = Number(result.rows[0]?.deleted || 0);
        results[dataClass] = { deleted, cutoff: cutoff.toISOString() };
        processed += deleted;
    }
    return { processed, failed: 0, networkLeasesDeleted, batchSize: configured.batchSize, classes: results };
}

module.exports = { DEFAULT_POLICY, RETENTION_CLASSES, policy, run };
