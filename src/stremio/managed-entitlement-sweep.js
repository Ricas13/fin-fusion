'use strict';

const { query } = require('../db');
const scanCursor = require('../automation/scan-cursor');
const managed = require('./managed-entitlements');

const ACTIVE_SCAN_KEY = 'stremio_managed.active_entitlements';
const INACTIVE_SCAN_KEY = 'stremio_managed.inactive_mappings';
const JOB_KEY = 'stremio_managed_accounts';

function isUuid(value) {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function batchSize(value = process.env.STREMIO_MANAGED_SWEEP_BATCH_SIZE) {
    return scanCursor.boundedInteger(value, 100, 10, 500);
}

function concurrency(value = process.env.STREMIO_MANAGED_SWEEP_CONCURRENCY) {
    return scanCursor.boundedInteger(value, 2, 1, 6);
}

function cleanFailure(error) {
    return managed.cleanFailure?.(error?.message || error)
        || String(error?.message || error || 'Managed Stremio sweep failed').replace(/\s+/g, ' ').trim().slice(0, 300);
}

async function wakeNextPage(queryFn = query) {
    const result = await queryFn(`
        UPDATE automation_job_state
        SET next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()
        WHERE job_key=$1 AND enabled=TRUE
        RETURNING job_key
    `, [JOB_KEY]);
    return result.rows[0] || null;
}

async function loadCursor(key, queryFn = query, cursorStore = scanCursor) {
    let cursor = await cursorStore.load(key, queryFn);
    if (cursor && !isUuid(cursor)) {
        await cursorStore.clear(key, queryFn);
        cursor = null;
    }
    return cursor;
}

async function inactivePage({ after = null, limit = batchSize() } = {}, queryFn = query) {
    const bounded = scanCursor.boundedInteger(limit, batchSize(), 1, 501);
    const params = [];
    let cursorSql = '';
    if (isUuid(after)) {
        params.push(after);
        cursorSql = `AND sma.id>$${params.length}::uuid`;
    }
    params.push(bounded);
    const result = await queryFn(`
        WITH effective AS (
            SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
            UNION ALL
            SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons
        )
        SELECT sma.id AS mapping_id,sma.customer_id,sma.server_id,sma.jellyfin_account_id,
               sma.access_token_encrypted,ja.jellyfin_user_id,ja.jellyfin_username,
               js.name AS server_name,js.base_url,js.media_server_type
        FROM stremio_managed_accounts sma
        JOIN stremio_entitlements e ON e.id=sma.entitlement_id
        JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
        JOIN jellyfin_servers js ON js.id=sma.server_id
        LEFT JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
        WHERE sma.status IN('active','error')
          AND (e.status<>'active' OR js.enabled=FALSE OR js.stremio_enabled=FALSE
               OR ee.subscription_id IS NULL OR ee.blocked=TRUE OR ee.access_expires_at<=NOW())
          ${cursorSql}
        ORDER BY sma.id
        LIMIT $${params.length}
    `, params);
    return result.rows;
}

async function activePage({ after = null, limit = batchSize() } = {}, queryFn = query) {
    const bounded = scanCursor.boundedInteger(limit, batchSize(), 1, 501);
    const params = [];
    let cursorSql = '';
    if (isUuid(after)) {
        params.push(after);
        cursorSql = `AND e.id>$${params.length}::uuid`;
    }
    params.push(bounded);
    const result = await queryFn(`
        WITH effective AS (
            SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_stremio_entitlements
            UNION ALL
            SELECT customer_id,subscription_id,access_expires_at,blocked FROM effective_customer_addons
        )
        SELECT e.id,e.customer_id,s.plan_id
        FROM stremio_entitlements e
        JOIN subscriptions s ON s.id=e.subscription_id
        JOIN effective ee ON ee.customer_id=e.customer_id AND ee.subscription_id=e.subscription_id
        WHERE e.status='active' AND ee.blocked=FALSE AND ee.access_expires_at>NOW()
          ${cursorSql}
        ORDER BY e.id
        LIMIT $${params.length}
    `, params);
    return result.rows;
}

function failureSummary(reasons, failed, label) {
    if (!failed) return null;
    if (typeof managed.summarizeFailures === 'function') return managed.summarizeFailures(reasons, failed, label);
    return `${failed} ${label} failure${failed === 1 ? '' : 's'}`;
}

async function runPage({
    key,
    pageFn,
    worker,
    label,
    queryFn = query,
    cursorStore = scanCursor,
    pageSize = batchSize(),
    workerConcurrency = concurrency()
}) {
    const after = await loadCursor(key, queryFn, cursorStore);
    const fetched = await pageFn({ after, limit: pageSize + 1 }, queryFn);
    const hasMore = fetched.length > pageSize;
    const rows = hasMore ? fetched.slice(0, pageSize) : fetched;
    const settled = await scanCursor.mapSettledBounded(rows, workerConcurrency, worker);
    let processed = 0;
    let failed = 0;
    const reasons = new Map();
    for (const outcome of settled) {
        if (outcome?.status === 'fulfilled') {
            processed += 1;
            continue;
        }
        failed += 1;
        const reason = cleanFailure(outcome?.reason);
        reasons.set(reason, Number(reasons.get(reason) || 0) + 1);
        console.warn(`${label} item failed:`, reason);
    }

    if (rows.length && hasMore) {
        const id = String(rows[rows.length - 1].mapping_id || rows[rows.length - 1].id || '');
        if (!isUuid(id)) throw new Error(`${label} returned an invalid keyset cursor.`);
        await cursorStore.save(key, id, queryFn);
    } else {
        await cursorStore.clear(key, queryFn);
    }

    return {
        total: rows.length,
        processed,
        failed,
        hasMore,
        warning: failureSummary(reasons, failed, label),
        cursor: rows.length && hasMore ? String(rows[rows.length - 1].mapping_id || rows[rows.length - 1].id) : null
    };
}

async function syncActiveBounded({
    queryFn = query,
    cursorStore = scanCursor,
    disableFn = row => managed.disableMapping(row, 'Managed Stremio entitlement is no longer active.'),
    mappingFn = entitlement => managed.mappings(entitlement),
    wakeFn = wakeNextPage
} = {}) {
    const inactive = await runPage({
        key: INACTIVE_SCAN_KEY,
        pageFn: inactivePage,
        worker: disableFn,
        label: 'managed Stremio cleanup',
        queryFn,
        cursorStore
    });
    const active = await runPage({
        key: ACTIVE_SCAN_KEY,
        pageFn: activePage,
        worker: mappingFn,
        label: 'managed Stremio synchronization',
        queryFn,
        cursorStore
    });

    const failed = Number(inactive.failed || 0) + Number(active.failed || 0);
    const hasMore = Boolean(inactive.hasMore || active.hasMore);
    // Healthy pages chain immediately, turning the old unbounded hourly sweep
    // into short resumable slices. A degraded page deliberately keeps the normal
    // job-health retry/backoff rather than hammering an unavailable media server.
    if (hasMore && failed === 0) await wakeFn(queryFn);

    const warning = [inactive.warning, active.warning].filter(Boolean).join('; ').slice(0, 1000) || null;
    return {
        total: Number(inactive.total || 0) + Number(active.total || 0),
        processed: Number(inactive.processed || 0) + Number(active.processed || 0),
        failed,
        revoked: Number(inactive.processed || 0),
        hasMore,
        inactive,
        active,
        ...(warning ? { warning } : {})
    };
}

module.exports = {
    ACTIVE_SCAN_KEY,
    INACTIVE_SCAN_KEY,
    JOB_KEY,
    isUuid,
    batchSize,
    concurrency,
    cleanFailure,
    wakeNextPage,
    inactivePage,
    activePage,
    runPage,
    syncActiveBounded
};
