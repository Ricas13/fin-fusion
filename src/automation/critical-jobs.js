'use strict';

// These jobs are part of CAPTAiNFiN's customer-access/revenue safety net.
// Keep one canonical list so worker startup, deployment verification and the
// operator UI cannot silently drift apart when a new recovery path is added.
const CUSTOMER_ACCESS_CRITICAL_JOBS = Object.freeze([
    'health',
    'entitlements',
    'free_capacity_backfill',
    'customer_inactivity',
    'billing',
    'provider_operation_recovery',
    'payment_events',
    'plan_changes',
    'stremio_managed_accounts',
    'stremio_external_tokens'
]);

function names() {
    return [...CUSTOMER_ACCESS_CRITICAL_JOBS];
}

function isCritical(jobKey) {
    return CUSTOMER_ACCESS_CRITICAL_JOBS.includes(String(jobKey || ''));
}

module.exports = { CUSTOMER_ACCESS_CRITICAL_JOBS, names, isCritical };
