'use strict';

const { query } = require('../db');

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
        if (requestRetryOnError && Array.isArray(result?.errors) && result.errors.length) {
            await requestRoleRetry().catch(() => null);
        }
        return result;
    } catch (error) {
        if (requestRetryOnError) await requestRoleRetry().catch(() => null);
        throw error;
    }
}

async function linkedCustomerIds(queryFn = query) {
    const result = await queryFn(`
        SELECT customer_id
        FROM customer_communication_preferences
        WHERE discord_user_id IS NOT NULL
          AND discord_user_id<>''
        ORDER BY customer_id
    `);
    return result.rows.map(row => row.customer_id).filter(Boolean);
}

function compactFailure(error) {
    return String(error?.message || error || 'Discord role reconciliation failed')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
}

async function reconcileLinkedCustomers({ queryFn = query, reconcileFn = null } = {}) {
    const customerIds = await linkedCustomerIds(queryFn);
    const runReconcile = reconcileFn || (customerId => reconcileCustomerDiscordRoles(customerId, { requestRetryOnError: false }));
    const summary = {
        total: customerIds.length,
        processed: 0,
        synced: 0,
        skipped: 0,
        failed: 0,
        failures: []
    };

    for (const customerId of customerIds) {
        try {
            const result = await runReconcile(customerId);
            summary.processed += 1;
            const roleErrors = Array.isArray(result?.errors) ? result.errors.filter(Boolean) : [];
            if (roleErrors.length) {
                summary.failed += 1;
                const failure = { customerId, error: compactFailure(roleErrors.join('; ')) };
                summary.failures.push(failure);
                if (!summary.warning) summary.warning = failure.error;
                console.warn('Discord role safety sweep customer degraded.', failure);
            } else if (result?.skipped) {
                summary.skipped += 1;
            } else {
                summary.synced += 1;
            }
        } catch (error) {
            summary.processed += 1;
            summary.failed += 1;
            const failure = { customerId, error: compactFailure(error) };
            summary.failures.push(failure);
            if (!summary.warning) summary.warning = failure.error;
            console.warn('Discord role safety sweep customer failed.', failure);
        }
    }

    return summary;
}

module.exports = {
    reconcileCustomerDiscordRoles,
    linkedCustomerIds,
    reconcileLinkedCustomers,
    requestRoleRetry,
    compactFailure
};
