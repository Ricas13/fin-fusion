'use strict';

const { query } = require('../db');
const registry = require('./registry');
const provisioning = require('./resilient-provisioning');
const scanCursor = require('../automation/scan-cursor');

const DEFAULT_RECONCILE_CONCURRENCY = 2;
const MAX_RECONCILE_CONCURRENCY = 8;
const DEFAULT_RECONCILE_LIMIT = 500;
const ACTIVE_ENTITLEMENT_SCAN_KEY = 'jellyfin.active_entitlements';

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

function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
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

async function dueProvisioningCustomers(limit, queryFn = query) {
    const bounded = boundedInteger(limit, 250, 1, 1000);
    const result = await queryFn(`
        SELECT cps.customer_id,cps.status AS provisioning_status,cps.next_attempt_at
        FROM customer_provisioning_state cps
        WHERE cps.status IN ('pending','running','blocked','failed')
          AND (cps.next_attempt_at IS NULL OR cps.next_attempt_at <= NOW())
        ORDER BY cps.next_attempt_at NULLS FIRST,cps.customer_id
        LIMIT $1
    `, [bounded]);
    return result.rows;
}

// Strictly bound active-entitlement discovery by first selecting a page from the
// customer primary-key index, then evaluating entitlement truth only for that
// page. The previous query materialized/aggregated the entire active subscription
// population before its final LIMIT, so a 250-row worker batch still scanned all
// subscriptions/customers. This shape makes one pass proportional to the number
// of customers inspected, not the total population, and the durable cursor lets
// subsequent passes continue after restarts.
async function activeCustomerScanPage({ after = null, limit = 250 } = {}, queryFn = query) {
    const bounded = boundedInteger(limit, 250, 1, 1001);
    const cursor = isUuid(after) ? after : null;
    const result = await queryFn(`
        WITH customer_page AS MATERIALIZED (
            SELECT c.id,c.access_paused_at
            FROM customers c
            WHERE ($1::uuid IS NULL OR c.id > $1::uuid)
            ORDER BY c.id
            LIMIT $2
        )
        SELECT cp.id AS customer_id,
               cps.status AS provisioning_status,
               cps.next_attempt_at,
               (cp.access_paused_at IS NULL AND EXISTS (
                    SELECT 1
                    FROM subscriptions s
                    LEFT JOIN customer_entitlement_overrides o
                      ON o.customer_id=s.customer_id AND o.subscription_id=s.id
                    WHERE s.customer_id=cp.id
                      AND s.superseded_by IS NULL
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
               )) AS entitlement_active
        FROM customer_page cp
        LEFT JOIN customer_provisioning_state cps ON cps.customer_id=cp.id
        ORDER BY cp.id
    `, [cursor, bounded]);
    return result.rows;
}

async function wakeEntitlementRetry(queryFn = query) {
    const result = await queryFn(`
        UPDATE automation_job_state
        SET next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()
        WHERE job_key='entitlements' AND enabled=TRUE
        RETURNING job_key
    `);
    return result.rows[0] || null;
}

// A customer is due when either:
//  1. a previous provisioning/deprovisioning attempt is pending/blocked/failed
//     and due (always given half of each worker batch at minimum), OR
//  2. they are found in the bounded active-customer scan and have never been
//     reconciled or their next scheduled verification/retry time has arrived.
//
// Catalogue visibility/active flags are deliberately not used here: once a
// subscription contract exists, retiring the plan from sale must not stop that
// customer's access from being reconciled. Permanent, administrator-present and
// service-extension access remain live even after the original provider period
// has ended. A raw customer-page cursor is persisted even when none of those
// customers are active, so large inactive populations cannot force the worker to
// rescan from customer #1 on every tick.
async function dueCustomerPage(limit = 250, { queryFn = query, cursorStore = scanCursor } = {}) {
    const bounded = boundedInteger(limit, 250, 1, 1000);
    const recoveryBudget = Math.max(1, Math.ceil(bounded / 2));
    const recoveryRows = await dueProvisioningCustomers(recoveryBudget, queryFn);
    const remaining = Math.max(0, bounded - recoveryRows.length);

    let after = null;
    if (cursorStore) {
        after = await cursorStore.load(ACTIVE_ENTITLEMENT_SCAN_KEY, queryFn);
        if (after && !isUuid(after)) {
            await cursorStore.clear(ACTIVE_ENTITLEMENT_SCAN_KEY, queryFn);
            after = null;
        }
    }

    let inspected = [];
    let hasMore = false;
    let cursor = after;
    if (remaining > 0) {
        const fetched = await activeCustomerScanPage({ after, limit: remaining + 1 }, queryFn);
        hasMore = fetched.length > remaining;
        inspected = hasMore ? fetched.slice(0, remaining) : fetched;
        if (inspected.length) cursor = String(inspected[inspected.length - 1].customer_id || '');
        if (cursorStore) {
            if (hasMore && isUuid(cursor)) await cursorStore.save(ACTIVE_ENTITLEMENT_SCAN_KEY, cursor, queryFn);
            else await cursorStore.clear(ACTIVE_ENTITLEMENT_SCAN_KEY, queryFn);
        }
    }

    const selected = [];
    const seen = new Set();
    for (const row of recoveryRows) {
        const id = String(row.customer_id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        selected.push(row);
    }
    for (const row of inspected) {
        if (row.entitlement_active !== true) continue;
        if (row.next_attempt_at && new Date(row.next_attempt_at).getTime() > Date.now()) continue;
        const id = String(row.customer_id || '');
        if (!id || seen.has(id)) continue;
        seen.add(id);
        selected.push(row);
    }

    return {
        rows: selected.slice(0, bounded),
        hasMore,
        cursor: hasMore && isUuid(cursor) ? cursor : null,
        inspected: inspected.length,
        recoveryCandidates: recoveryRows.length,
        limit: bounded
    };
}

// Compatibility alias for callers/tests that only need one bounded page and do
// not want to mutate the durable recurring-worker cursor.
async function dueCustomers(limit = 250) {
    return (await dueCustomerPage(limit, { cursorStore: null })).rows;
}

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
    const page = await dueCustomerPage(limit);
    const rows = page.rows;
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

    // A healthy partial population page should continue immediately instead of
    // waiting five minutes. Degraded pages deliberately leave scheduling to
    // job-health's bounded backoff; the cursor was already persisted, so one bad
    // customer cannot pin discovery to the start of the population.
    if (page.hasMore && failed === 0 && blocked === 0) await wakeEntitlementRetry();

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
        hasMore: page.hasMore,
        inspected: page.inspected,
        recoveryCandidates: page.recoveryCandidates,
        cursor: page.cursor,
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
    ACTIVE_ENTITLEMENT_SCAN_KEY,
    boundedInteger,
    reconcileConcurrency,
    reconcileLimit,
    isUuid,
    mapBounded,
    dueProvisioningCustomers,
    activeCustomerScanPage,
    dueCustomerPage,
    dueCustomers,
    dueActiveCustomers,
    wakeEntitlementRetry,
    reconcileActiveEntitlements,
    ensureFailureBackoff,
    healthcheckAllServers,
    cleanFailureMessage,
    summarizeFailureReasons
};
