'use strict';

const { query } = require('../db');

async function reconcileCustomerDiscordRoles(customerId) {
    const provisioning = require('../jellyfin/resilient-provisioning');
    return provisioning.reconcileDiscordRoles(customerId);
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

async function reconcileLinkedCustomers({ queryFn = query, reconcileFn = reconcileCustomerDiscordRoles } = {}) {
    const customerIds = await linkedCustomerIds(queryFn);
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
            const result = await reconcileFn(customerId);
            summary.processed += 1;
            if (result?.skipped) summary.skipped += 1;
            else summary.synced += 1;
        } catch (error) {
            summary.processed += 1;
            summary.failed += 1;
            summary.failures.push({
                customerId,
                error: String(error?.message || error || 'Discord role reconciliation failed').replace(/\s+/g, ' ').trim().slice(0, 300)
            });
            console.warn('Discord role safety sweep customer failed.', {
                customerId,
                error: summary.failures[summary.failures.length - 1].error
            });
        }
    }

    return summary;
}

module.exports = {
    reconcileCustomerDiscordRoles,
    linkedCustomerIds,
    reconcileLinkedCustomers
};
