'use strict';

const { query } = require('../db');
const scanCursor = require('../automation/scan-cursor');

const DISCORD_ROLE_SCAN_KEY = 'discord_roles.linked_customers';

function scanBatchSize(value = process.env.DISCORD_ROLE_RECONCILE_BATCH_SIZE) {
    return scanCursor.boundedInteger(value, 250, 25, 1000);
}

function scanConcurrency(value = process.env.DISCORD_ROLE_RECONCILE_CONCURRENCY) {
    return scanCursor.boundedInteger(value, 4, 1, 8);
}

function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

async function requestRoleRetry(queryFn = query) {
    const result = await queryFn(`
        UPDATE automation_job_state
        SET next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()
        WHERE job_key='discord_roles' AND enabled=TRUE
        RETURNING *
    `);
    return result.rows[0] || null;
}

async function reconcileCustomerDiscordRoles(customerId, { requestRetryOnError = true } = {}) {
    const provisioning = require('../jellyfin/resilient-provisioning');
    try {
        const result = await provisioning.reconcileDiscordRoles(customerId);
        // Discord API failures can be transient, so wake the repair worker.
        // Missing/ambiguous plan configuration is not transient and is surfaced
        // by the regular sweep instead of creating an immediate retry loop.
        if (requestRetryOnError && Array.isArray(result?.errors) && result.errors.length) {
            await requestRoleRetry().catch(() => null);
        }
        return result;
    } catch (error) {
        if (requestRetryOnError) await requestRoleRetry().catch(() => null);
        throw error;
    }
}

async function linkedCustomerIds(queryFn = query, { after = null, limit = scanBatchSize() } = {}) {
    const boundedLimit = scanCursor.boundedInteger(limit, scanBatchSize(), 1, 1001);
    const params = [];
    let afterSql = '';
    if (isUuid(after)) {
        params.push(after);
        afterSql = `AND customer_id>$${params.length}::uuid`;
    }
    params.push(boundedLimit);
    const result = await queryFn(`
        SELECT customer_id
        FROM customer_communication_preferences
        WHERE discord_user_id IS NOT NULL
          AND discord_user_id<>''
          ${afterSql}
        ORDER BY customer_id
        LIMIT $${params.length}
    `, params);
    return result.rows.map(row => row.customer_id).filter(Boolean);
}

function compactFailure(error) {
    return String(error?.message || error || 'Discord role reconciliation failed')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

async function reconcileLinkedCustomers({ queryFn = query, reconcileFn = null, cursorStore = null } = {}) {
    const batchSize = scanBatchSize();
    // Tests and one-off callers that inject a query function retain the old
    // single-call behaviour unless they explicitly provide a cursor store.
    // Production uses durable keyset progress so a restart cannot send every
    // sweep back to the first linked Discord customer.
    const store = cursorStore || (queryFn === query ? scanCursor : null);
    let after = store ? await store.load(DISCORD_ROLE_SCAN_KEY, queryFn) : null;
    if (after && !isUuid(after)) {
        await store.clear(DISCORD_ROLE_SCAN_KEY, queryFn);
        after = null;
    }

    const fetched = await linkedCustomerIds(queryFn, {
        after,
        limit: store ? batchSize + 1 : batchSize
    });
    const hasMore = Boolean(store && fetched.length > batchSize);
    const customerIds = hasMore ? fetched.slice(0, batchSize) : fetched;
    const runReconcile = reconcileFn || (customerId => reconcileCustomerDiscordRoles(customerId, { requestRetryOnError: false }));
    const settled = await scanCursor.mapSettledBounded(customerIds, scanConcurrency(), runReconcile);
    const summary = {
        total: customerIds.length,
        processed: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
        failures: [],
        hasMore
    };

    for (let index = 0; index < customerIds.length; index += 1) {
        const customerId = customerIds[index];
        const outcome = settled[index];
        summary.processed += 1;
        if (outcome?.status === 'rejected') {
            summary.failed += 1;
            const failure = { customerId, error: compactFailure(outcome.reason) };
            summary.failures.push(failure);
            if (!summary.warning) summary.warning = failure.error;
            console.warn('Discord role safety sweep customer failed.', failure);
            continue;
        }

        const result = outcome?.value;
        const roleErrors = Array.isArray(result?.errors) ? result.errors.filter(Boolean) : [];
        const configurationErrors = Array.isArray(result?.configurationErrors)
            ? result.configurationErrors.filter(Boolean)
            : [];
        const failures = [...roleErrors, ...configurationErrors];
        if (failures.length) {
            summary.failed += 1;
            const failure = { customerId, error: compactFailure(failures.join('; ')) };
            summary.failures.push(failure);
            if (!summary.warning) summary.warning = failure.error;
            console.warn('Discord role safety sweep customer degraded.', failure);
        } else if (result?.skipped) {
            summary.skipped += 1;
        } else {
            summary.synced += 1;
        }
    }

    if (store) {
        if (customerIds.length && hasMore) {
            const nextCursor = customerIds[customerIds.length - 1];
            await store.save(DISCORD_ROLE_SCAN_KEY, nextCursor, queryFn);
            summary.cursor = nextCursor;
            // Continue a healthy large scan immediately rather than waiting for
            // the normal 12-hour safety interval. Degraded runs use job-health's
            // bounded retry delay, which prevents a Discord outage becoming a
            // hot loop while still advancing the durable cursor on the retry.
            if (summary.failed === 0) await requestRoleRetry(queryFn);
        } else {
            await store.clear(DISCORD_ROLE_SCAN_KEY, queryFn);
            summary.cursor = null;
        }
    }

    return summary;
}

module.exports = {
    DISCORD_ROLE_SCAN_KEY,
    reconcileCustomerDiscordRoles,
    linkedCustomerIds,
    reconcileLinkedCustomers,
    requestRoleRetry,
    compactFailure,
    scanBatchSize,
    scanConcurrency
};
