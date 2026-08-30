'use strict';

const { query } = require('../db');
const registry = require('./registry');
const provisioning = require('./resilient-provisioning');

function cleanFailureMessage(value) {
    return String(value || 'Unknown entitlement reconciliation failure')
        .replace(/[\r\n\t\u2028\u2029]+/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim()
        .slice(0, 300) || 'Unknown entitlement reconciliation failure';
}

function summarizeFailureReasons(reasons, failed) {
    if (!failed) return null;
    const ranked = [...reasons.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    const shown = ranked.slice(0, 2);
    const shownCount = shown.reduce((sum, [, count]) => sum + count, 0);
    const detail = shown.map(([message, count]) => `${count}× ${message}`).join('; ');
    const remainder = Math.max(0, failed - shownCount);
    return `${failed} entitlement reconciliation${failed === 1 ? '' : 's'} failed${detail ? `: ${detail}` : ''}${remainder ? `; ${remainder} other failure${remainder === 1 ? '' : 's'}` : ''}`.slice(0, 1000);
}

// A customer is due when either:
//  1. they currently have an active entitlement and have never been reconciled
//     (or their next scheduled verification/retry time has arrived), OR
//  2. a previous provisioning/deprovisioning attempt is pending/blocked/failed
//     and is due. The second branch is important for expired/cancelled users:
//     if Jellyfin was offline when access was meant to be disabled, they still
//     need to be retried even though they no longer have an active subscription.
async function dueCustomers(limit = 250) {
    const bounded = Math.max(1, Math.min(1000, Number(limit) || 250));
    const result = await query(`
        WITH active AS (
            SELECT DISTINCT s.customer_id
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            JOIN customers c ON c.id=s.customer_id
            WHERE s.status IN ('active','trialing','past_due')
              AND s.current_period_end > NOW()
              AND p.active=TRUE
              AND c.access_paused_at IS NULL
        ), candidates AS (
            SELECT a.customer_id,
                   cps.status AS provisioning_status,
                   cps.next_attempt_at
            FROM active a
            LEFT JOIN customer_provisioning_state cps ON cps.customer_id=a.customer_id
            WHERE cps.next_attempt_at IS NULL OR cps.next_attempt_at <= NOW()

            UNION

            SELECT cps.customer_id,
                   cps.status AS provisioning_status,
                   cps.next_attempt_at
            FROM customer_provisioning_state cps
            WHERE cps.status IN ('pending','running','blocked','failed')
              AND (cps.next_attempt_at IS NULL OR cps.next_attempt_at <= NOW())
        )
        SELECT customer_id,
               MIN(provisioning_status) AS provisioning_status,
               MIN(next_attempt_at) AS next_attempt_at
        FROM candidates
        GROUP BY customer_id
        ORDER BY MIN(next_attempt_at) NULLS FIRST,customer_id
        LIMIT $1
    `, [bounded]);
    return result.rows;
}

// Compatibility alias retained for existing callers/tests.
async function dueActiveCustomers(limit = 250) {
    return dueCustomers(limit);
}

async function reconcileActiveEntitlements(options = {}) {
    const rows = await dueCustomers(options.limit || 250);
    let succeeded = 0;
    let blocked = 0;
    let failed = 0;
    const failureReasons = new Map();
    for (const row of rows) {
        try {
            await provisioning.reconcileCustomer(row.customer_id);
            succeeded += 1;
        } catch (error) {
            const state = await provisioning.control.getCustomerState(row.customer_id).catch(() => null);
            if (state?.status === 'blocked') blocked += 1;
            else {
                failed += 1;
                const reason = cleanFailureMessage(error?.message || error);
                failureReasons.set(reason, Number(failureReasons.get(reason) || 0) + 1);
            }
            console.error(`Entitlement reconcile failed for ${row.customer_id}:`, error.message);
        }
    }
    const warning = summarizeFailureReasons(failureReasons, failed);
    return { total: rows.length, succeeded, blocked, failed, ...(warning ? { warning } : {}) };
}

async function healthcheckAllServers() {
    const servers = await registry.listServers({ enabledOnly: true });
    const results = [];
    for (const server of servers) {
        results.push({ serverId: server.id, name: server.name, ...(await registry.healthcheckServer(server.id)) });
    }
    return results;
}

module.exports = { dueCustomers, dueActiveCustomers, reconcileActiveEntitlements, healthcheckAllServers, cleanFailureMessage, summarizeFailureReasons };
