'use strict';

const { query } = require('../db');
const registry = require('./registry');
const { reconcileCustomer } = require('./provisioning');

async function reconcileActiveEntitlements() {
    const result = await query(`
        SELECT DISTINCT customer_id
        FROM subscriptions
        WHERE status IN ('active','trialing','past_due')
          AND current_period_end > NOW()
    `);

    let succeeded = 0;
    let failed = 0;
    for (const row of result.rows) {
        try {
            await reconcileCustomer(row.customer_id);
            succeeded += 1;
        } catch (error) {
            failed += 1;
            console.error(`Active entitlement reconcile failed for ${row.customer_id}:`, error.message);
        }
    }
    return { total: result.rowCount, succeeded, failed };
}

async function healthcheckAllServers() {
    const servers = await registry.listServers({ enabledOnly: true });
    const results = [];
    for (const server of servers) {
        results.push({ serverId: server.id, name: server.name, ...(await registry.healthcheckServer(server.id)) });
    }
    return results;
}

module.exports = { reconcileActiveEntitlements, healthcheckAllServers };
