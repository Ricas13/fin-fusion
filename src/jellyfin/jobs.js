'use strict';

const { query } = require('../db');
const registry = require('./registry');
const provisioning = require('./resilient-provisioning');

async function dueActiveCustomers(limit = 250) {
    const bounded = Math.max(1, Math.min(1000, Number(limit) || 250));
    const result = await query(`
        SELECT DISTINCT s.customer_id,
               cps.status AS provisioning_status,
               cps.next_attempt_at
        FROM subscriptions s
        LEFT JOIN customer_provisioning_state cps ON cps.customer_id=s.customer_id
        WHERE s.status IN ('active','trialing','past_due')
          AND s.current_period_end > NOW()
          AND (cps.next_attempt_at IS NULL OR cps.next_attempt_at <= NOW())
        ORDER BY cps.next_attempt_at NULLS FIRST, s.customer_id
        LIMIT $1
    `, [bounded]);
    return result.rows;
}

async function reconcileActiveEntitlements(options = {}) {
    const rows = await dueActiveCustomers(options.limit || 250);
    let succeeded = 0;
    let blocked = 0;
    let failed = 0;
    for (const row of rows) {
        try {
            await provisioning.reconcileCustomer(row.customer_id);
            succeeded += 1;
        } catch (error) {
            const state = await provisioning.control.getCustomerState(row.customer_id).catch(() => null);
            if (state?.status === 'blocked') blocked += 1;
            else failed += 1;
            console.error(`Active entitlement reconcile failed for ${row.customer_id}:`, error.message);
        }
    }
    return { total: rows.length, succeeded, blocked, failed };
}

async function healthcheckAllServers() {
    const servers = await registry.listServers({ enabledOnly: true });
    const results = [];
    for (const server of servers) {
        results.push({ serverId: server.id, name: server.name, ...(await registry.healthcheckServer(server.id)) });
    }
    return results;
}

module.exports = { dueActiveCustomers, reconcileActiveEntitlements, healthcheckAllServers };
