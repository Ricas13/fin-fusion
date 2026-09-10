'use strict';

const { query } = require('../db');
const registry = require('./registry');
const provisioning = require('./resilient-provisioning');

const DEFAULT_RECONCILE_CONCURRENCY = 2;
const MAX_RECONCILE_CONCURRENCY = 8;
const DEFAULT_RECONCILE_LIMIT = 500;

function boundedInteger(value, fallback, min, max) {
    const parsed = Number.parseInt(value == null ? '' : String(value), 10);
    if (!Number.isInteger(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function reconcileConcurrency(value = process.env.ENTITLEMENT_RECONCILE_CONCURRENCY) {
    return boundedInteger(value, DEFAULT_RECONCILE_CONCURRENCY, 1, MAX_RECONCILE_CONCURRENCY);
}

function reconcileLimit(value = process.env.ENTITLEMENT_RECONCILE_LIMIT) {
    return boundedInteger(value, DEFAULT_RECONCILE_LIMIT, 1, 1000);
}

async function mapBounded(items, limit, mapper) {
    const values = Array.from(items || []);
    if (!values.length) return [];
    const output = new Array(values.length);
    let cursor = 0;
    const workers = Math.min(Math.max(1, Number(limit) || 1), values.length);
    await Promise.all(Array.from({ length: workers }, async () => {
        for (;;) {
            const index = cursor++;
            if (index >= values.length) return;
            output[index] = await mapper(values[index], index);
        }
    }));
    return output;
}

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
//  1. they currently have a live contract and have never been reconciled
//     (or their next scheduled verification/retry time has arrived), OR
//  2. a previous provisioning/deprovisioning attempt is pending/blocked/failed
//     and is due. Catalogue visibility/active flags are deliberately not used
//     here: once a subscription contract exists, retiring the plan from sale
//     must not stop that customer's access from being reconciled. Permanent,
//     administrator-present and service-extension access remain live even after
//     the original provider period has ended. Keep this population aligned with
//     subscription-state's canonical entitlement truth so recovery cannot omit
//     an access state that the customer-facing product considers entitled.
async function dueCustomers(limit = 250) {
    const bounded = Math.max(1, Math.min(1000, Number(limit) || 250));
    const result = await query(`
        WITH active AS (
            SELECT DISTINCT s.customer_id
            FROM subscriptions s
            JOIN plans p ON p.id=s.plan_id
            JOIN customers c ON c.id=s.customer_id
            LEFT JOIN customer_entitlement_overrides o
              ON o.customer_id=s.customer_id AND o.subscription_id=s.id
            WHERE s.superseded_by IS NULL
              AND s.starts_at <= NOW()
              AND (
                (o.permanent_access=TRUE AND o.revoked_at IS NULL AND o.subscription_id=s.id)
                OR public.subscription_admin_present(s.customer_id,'jellyfin',s.id)
                OR (s.status IN ('active','trialing','past_due','paused') AND s.current_period_end > NOW())
                OR (
                  COALESCE(s.service_extension_days,0)>0
                  AND s.status IN ('active','trialing','past_due','paused','cancelled','expired')
                  AND (s.current_period_end+((s.service_extension_days||' days')::interval)) > NOW()
                )
              )
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

async function ensureFailureBackoff(customerId, error) {
    let state = await provisioning.control.getCustomerState(customerId).catch(() => null);
    if (!['failed', 'blocked'].includes(String(state?.status || ''))) {
        const classified = provisioning.control.classifyError(error);
        await provisioning.control.markCustomerProblem(customerId, classified.status, error).catch(markError => {
            console.error(`Unable to persist entitlement failure backoff for ${customerId}:`, markError.message);
        });
        state = await provisioning.control.getCustomerState(customerId).catch(() => state);
    }
    return state;
}

async function reconcileActiveEntitlements(options = {}) {
    const limit = options.limit == null ? reconcileLimit() : boundedInteger(options.limit, DEFAULT_RECONCILE_LIMIT, 1, 1000);
    const concurrency = options.concurrency == null ? reconcileConcurrency() : boundedInteger(options.concurrency, DEFAULT_RECONCILE_CONCURRENCY, 1, MAX_RECONCILE_CONCURRENCY);
    const rows = await dueCustomers(limit);
    const results = await mapBounded(rows, concurrency, async row => {
        try {
            await provisioning.reconcileCustomer(row.customer_id);
            return { status: 'succeeded' };
        } catch (error) {
            // Some failures can occur before reconcileCustomerUnlocked reaches
            // markCustomerRunning (for example an entitlement/hold read). Make
            // sure those failures still receive durable backoff; otherwise a
            // NULL next_attempt_at row can sit at the head of every bounded batch.
            const state = await ensureFailureBackoff(row.customer_id, error);
            if (state?.status === 'blocked') {
                console.error(`Entitlement reconcile blocked for ${row.customer_id}:`, error.message);
                return { status: 'blocked' };
            }
            const reason = cleanFailureMessage(error?.message || error);
            console.error(`Entitlement reconcile failed for ${row.customer_id}:`, error.message);
            return { status: 'failed', reason };
        }
    });

    let succeeded = 0;
    let blocked = 0;
    let failed = 0;
    const failureReasons = new Map();
    for (const result of results) {
        if (result?.status === 'succeeded') succeeded += 1;
        else if (result?.status === 'blocked') blocked += 1;
        else if (result?.status === 'failed') {
            failed += 1;
            failureReasons.set(result.reason, Number(failureReasons.get(result.reason) || 0) + 1);
        }
    }

    const warning = summarizeFailureReasons(failureReasons, failed);
    const blockedWarning = blocked
        ? `${blocked} entitlement reconciliation${blocked === 1 ? '' : 's'} blocked pending recovery.`
        : null;
    const combinedWarning = [blockedWarning, warning].filter(Boolean).join('; ').slice(0, 1000) || null;
    return {
        total: rows.length,
        succeeded,
        blocked,
        failed,
        concurrency,
        limit,
        ...(combinedWarning ? { warning: combinedWarning } : {})
    };
}

async function healthcheckAllServers() {
    const servers = await registry.listServers({ enabledOnly: true });
    const results = [];
    for (const server of servers) {
        results.push({ serverId: server.id, name: server.name, ...(await registry.healthcheckServer(server.id)) });
    }
    return results;
}

module.exports = {
    DEFAULT_RECONCILE_CONCURRENCY,
    MAX_RECONCILE_CONCURRENCY,
    DEFAULT_RECONCILE_LIMIT,
    boundedInteger,
    reconcileConcurrency,
    reconcileLimit,
    mapBounded,
    dueCustomers,
    dueActiveCustomers,
    reconcileActiveEntitlements,
    ensureFailureBackoff,
    healthcheckAllServers,
    cleanFailureMessage,
    summarizeFailureReasons
};