'use strict';

// Single source of truth for the Customers filtered/paginated query, reused by
// the list page and bulk-operation "select all matching" resolution. Product
// workspaces deep-link here with a service filter rather than owning duplicate
// customer implementations.

const { query } = require('../db');
const tableSort = require('./admin-table-sort');

const STATUS_VALUES = ['trialing', 'active', 'past_due', 'paused', 'cancelled', 'expired'];
const RECON_VALUES = ['pending', 'running', 'successful', 'failed'];
const PAYMENT_PROVIDERS = ['stripe', 'paypal', 'manual'];
const SERVICE_VALUES = ['jellyfin', 'stremio'];
const MAX_MATCHING = 5000;
const CUSTOMER_NAME_SORT = `COALESCE(NULLIF(c.display_name,''),NULLIF(au.username,''),(SELECT ja_identity.jellyfin_username FROM jellyfin_accounts ja_identity WHERE ja_identity.customer_id=c.id AND NULLIF(ja_identity.jellyfin_username,'') IS NOT NULL ORDER BY COALESCE(ja_identity.is_primary,FALSE) DESC,COALESCE(ja_identity.disabled,FALSE) ASC,ja_identity.created_at ASC LIMIT 1),NULLIF(c.email,''))`;
const CUSTOMER_SORTS = Object.freeze({
    recent: { expression: 'COALESCE(acc.last_activity_at,c.created_at)', defaultDirection: 'desc', nulls: 'last' },
    registered: { expression: 'c.created_at', defaultDirection: 'desc', nulls: 'last' },
    name: { expression: CUSTOMER_NAME_SORT, defaultDirection: 'asc', nulls: 'last' },
    plan: { expression: "COALESCE(p.name,'')", defaultDirection: 'asc' },
    status: { expression: "COALESCE(cur.status,'')", defaultDirection: 'asc' },
    expiring: { expression: 'CASE WHEN COALESCE(p.is_free_tier,FALSE) THEN NULL ELSE cur.current_period_end END', defaultDirection: 'asc', nulls: 'last' },
    jellyfin: { expression: 'COALESCE(acc.account_count,0)', defaultDirection: 'desc' },
    server: { expression: "COALESCE(acc.server_names,'')", defaultDirection: 'asc' },
    sync: { expression: 'COALESCE(recon.rank,99)', defaultDirection: 'asc' },
    custom: { expression: 'COALESCE(ovr.has_override,FALSE)', defaultDirection: 'desc' }
});

function isUuid(v) {
    return typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);
}

function baseJoins() {
    return `
        FROM customers c
        LEFT JOIN app_users au ON au.id=c.user_id
        LEFT JOIN LATERAL (
            SELECT s.* FROM subscriptions s WHERE s.customer_id=c.id
            ORDER BY s.current_period_end DESC,s.created_at DESC LIMIT 1
        ) cur ON TRUE
        LEFT JOIN plans p ON p.id=cur.plan_id
        LEFT JOIN LATERAL (
            SELECT COUNT(*)::int AS account_count,MAX(ja.last_activity_at) AS last_activity_at,
                   BOOL_OR(NOT ja.disabled) AS has_enabled_account,
                   STRING_AGG(DISTINCT js.name, ', ' ORDER BY js.name) AS server_names
            FROM jellyfin_accounts ja
            JOIN jellyfin_servers js ON js.id=ja.server_id
            WHERE ja.customer_id=c.id
        ) acc ON TRUE
        LEFT JOIN LATERAL (
            SELECT MIN(CASE jpr.status WHEN 'failed' THEN 1 WHEN 'pending' THEN 2 WHEN 'running' THEN 3 ELSE 4 END) AS rank
            FROM jellyfin_accounts ja2 JOIN jellyfin_policy_reconciliation jpr ON jpr.jellyfin_account_id=ja2.id
            WHERE ja2.customer_id=c.id
        ) recon ON TRUE
        LEFT JOIN LATERAL (
            SELECT provider FROM payment_customers pc WHERE pc.customer_id=c.id ORDER BY pc.updated_at DESC LIMIT 1
        ) pay ON TRUE
        LEFT JOIN LATERAL (
            SELECT EXISTS(
                SELECT 1 FROM customer_policy_overrides cpo WHERE cpo.customer_id=c.id AND (
                    cpo.streams IS NOT NULL OR cpo.allow_downloads IS NOT NULL OR cpo.allow_video_transcoding IS NOT NULL OR
                    cpo.allow_audio_transcoding IS NOT NULL OR cpo.allow_remuxing IS NOT NULL OR cpo.allow_live_tv IS NOT NULL OR
                    cpo.allow_live_tv_management IS NOT NULL OR cpo.allow_remote_access IS NOT NULL
                )
                UNION ALL SELECT 1 FROM customer_library_overrides clo WHERE clo.customer_id=c.id
            ) AS has_override
        ) ovr ON TRUE
    `;
}

const RECON_RANK = { failed: 1, pending: 2, running: 3, successful: 4 };

function buildWhere(filters, scope) {
    const where = [];
    const params = [];
    function p(value) { params.push(value); return `$${params.length}`; }

    if (filters.q) {
        const term = `%${String(filters.q).trim().slice(0, 80)}%`;
        const idx = p(term);
        where.push(`(COALESCE(c.display_name,'') ILIKE ${idx} OR COALESCE(c.email,'') ILIKE ${idx} OR COALESCE(au.username,'') ILIKE ${idx} OR EXISTS (SELECT 1 FROM jellyfin_accounts jaq WHERE jaq.customer_id=c.id AND jaq.jellyfin_username ILIKE ${idx}))`);
    }

    if (filters.service && SERVICE_VALUES.includes(filters.service)) {
        const service = p(filters.service);
        where.push(`EXISTS (
            SELECT 1 FROM subscriptions ss
            JOIN plans sp ON sp.id=ss.plan_id
            WHERE ss.customer_id=c.id
              AND ((${service}='jellyfin' AND COALESCE(NULLIF(ss.service_type_snapshot,''),sp.service_type,'jellyfin') IN ('jellyfin','bundle'))
                   OR (${service}='stremio' AND COALESCE(NULLIF(ss.service_type_snapshot,''),sp.service_type,'jellyfin') IN ('stremio','bundle')))
        )`);
    }

    if (filters.serverId && isUuid(filters.serverId)) {
        where.push(`EXISTS (SELECT 1 FROM jellyfin_accounts jas WHERE jas.customer_id=c.id AND jas.server_id=${p(filters.serverId)})`);
    }

    if (filters.planId && isUuid(filters.planId)) {
        where.push(`cur.plan_id=${p(filters.planId)}`);
    }

    if (filters.status) {
        if (filters.status === 'none') where.push('cur.id IS NULL');
        else if (STATUS_VALUES.includes(filters.status)) where.push(`cur.status=${p(filters.status)}`);
    }

    if (filters.accountStatus === 'portal_disabled') where.push('au.active=FALSE');
    else if (filters.accountStatus === 'enabled') where.push('acc.has_enabled_account=TRUE');
    else if (filters.accountStatus === 'disabled') where.push('(acc.has_enabled_account IS NOT TRUE)');

    if (filters.paymentProvider) {
        if (filters.paymentProvider === 'none') where.push('pay.provider IS NULL');
        else if (PAYMENT_PROVIDERS.includes(filters.paymentProvider)) where.push(`pay.provider=${p(filters.paymentProvider)}`);
    }

    if (filters.expiryFrom) where.push(`COALESCE(p.is_free_tier,FALSE)=FALSE AND cur.current_period_end >= ${p(filters.expiryFrom)}::timestamptz`);
    if (filters.expiryTo) where.push(`COALESCE(p.is_free_tier,FALSE)=FALSE AND cur.current_period_end <= ${p(filters.expiryTo)}::timestamptz`);
    if (filters.lastActiveFrom) where.push(`acc.last_activity_at >= ${p(filters.lastActiveFrom)}::timestamptz`);
    if (filters.lastActiveTo) where.push(`acc.last_activity_at <= ${p(filters.lastActiveTo)}::timestamptz`);
    if (filters.registeredFrom) where.push(`c.created_at >= ${p(filters.registeredFrom)}::timestamptz`);
    if (filters.registeredTo) where.push(`c.created_at <= ${p(filters.registeredTo)}::timestamptz`);

    if (filters.reconciliationStatus) {
        if (filters.reconciliationStatus === 'none') where.push('recon.rank IS NULL');
        else if (RECON_VALUES.includes(filters.reconciliationStatus)) where.push(`recon.rank=${p(RECON_RANK[filters.reconciliationStatus])}`);
    }

    if (filters.hasOverride === true) where.push('ovr.has_override=TRUE');
    else if (filters.hasOverride === false) where.push('(ovr.has_override IS NOT TRUE)');

    if (filters.isFreeTier === true) where.push('COALESCE(p.is_free_tier,FALSE)=TRUE');

    if (filters.library) {
        const name = p(String(filters.library).trim().slice(0, 200));
        where.push(`(
            EXISTS (SELECT 1 FROM customer_library_overrides clo2 WHERE clo2.customer_id=c.id AND clo2.granted=TRUE AND lower(clo2.library_name)=lower(${name}))
            OR (
                NOT EXISTS (SELECT 1 FROM customer_library_overrides clo3 WHERE clo3.customer_id=c.id AND clo3.granted=FALSE AND lower(clo3.library_name)=lower(${name}))
                AND (
                    p.library_access_mode IS NULL OR p.library_access_mode='all'
                    OR (p.library_access_mode='include' AND lower(${name})=ANY(SELECT lower(x) FROM unnest(p.library_names) x))
                    OR (p.library_access_mode='exclude' AND lower(${name})<>ALL(SELECT lower(x) FROM unnest(p.library_names) x))
                )
            )
        )`);
    }

    return { whereSql: where.length ? `WHERE ${where.join(' AND ')}` : '', params };
}

const SELECT_COLUMNS = `
    c.id,c.display_name,c.email,c.created_at,
    au.username AS login_username,au.active AS login_active,
    (SELECT ja_identity.jellyfin_username
       FROM jellyfin_accounts ja_identity
      WHERE ja_identity.customer_id=c.id AND NULLIF(ja_identity.jellyfin_username,'') IS NOT NULL
      ORDER BY COALESCE(ja_identity.is_primary,FALSE) DESC,COALESCE(ja_identity.disabled,FALSE) ASC,ja_identity.created_at ASC
      LIMIT 1) AS jellyfin_username,
    cur.status AS subscription_status,
    CASE WHEN COALESCE(p.is_free_tier,FALSE) THEN NULL ELSE cur.current_period_end END AS current_period_end,
    p.id AS plan_id,p.name AS plan_name,p.code AS plan_code,COALESCE(p.is_free_tier,FALSE) AS is_free_tier,
    acc.account_count,acc.last_activity_at,acc.has_enabled_account,acc.server_names,
    recon.rank AS recon_rank,pay.provider AS payment_provider,ovr.has_override
`;

function normalizeCustomerSort(input = {}) {
    if (typeof input === 'string') return tableSort.normalize({ sort: input }, CUSTOMER_SORTS, 'recent');
    return tableSort.normalize(input, CUSTOMER_SORTS, 'recent');
}

async function listCustomers(filters, scope, { page = 1, pageSize = 25, sort = 'recent', dir } = {}) {
    const { whereSql, params } = buildWhere(filters, scope);
    const sortState = normalizeCustomerSort(typeof sort === 'object' ? sort : { sort, dir });
    const orderSql = tableSort.orderBy(sortState, CUSTOMER_SORTS, 'c.id ASC');
    const boundedPageSize = Math.min(Math.max(parseInt(pageSize, 10) || 25, 5), 100);
    const boundedPage = Math.max(parseInt(page, 10) || 1, 1);
    const offset = (boundedPage - 1) * boundedPageSize;
    const limitIdx = params.length + 1;
    const offsetIdx = params.length + 2;
    const rows = await query(`SELECT ${SELECT_COLUMNS} ${baseJoins()} ${whereSql} ${orderSql} LIMIT $${limitIdx} OFFSET $${offsetIdx}`, [...params, boundedPageSize, offset]);
    const countResult = await query(`SELECT COUNT(*)::int AS n ${baseJoins()} ${whereSql}`, params);
    return { rows: rows.rows, total: countResult.rows[0].n, page: boundedPage, pageSize: boundedPageSize, sort: sortState };
}

async function exportRows(filters, scope) {
    const { whereSql, params } = buildWhere(filters, scope);
    const result = await query(`SELECT ${SELECT_COLUMNS} ${baseJoins()} ${whereSql} ORDER BY c.id LIMIT ${MAX_MATCHING}`, params);
    return result.rows;
}

async function matchingCustomerIds(filters, scope) {
    const { whereSql, params } = buildWhere(filters, scope);
    const result = await query(`SELECT c.id ${baseJoins()} ${whereSql} ORDER BY c.id LIMIT ${MAX_MATCHING}`, params);
    return result.rows.map(row => row.id);
}

async function reauthorizeCustomerIds(candidateIds, scope) {
    const ids = Array.from(new Set((candidateIds || []).filter(isUuid))).slice(0, MAX_MATCHING);
    if (!ids.length) return [];
    const { whereSql, params } = buildWhere({}, scope);
    const idParamIdx = params.length + 1;
    const result = await query(`SELECT c.id ${baseJoins()} ${whereSql}${whereSql ? ' AND' : 'WHERE'} c.id=ANY($${idParamIdx}::uuid[])`, [...params, ids]);
    return result.rows.map(row => row.id);
}

module.exports = {
    MAX_MATCHING,
    STATUS_VALUES,
    RECON_VALUES,
    PAYMENT_PROVIDERS,
    SERVICE_VALUES,
    CUSTOMER_SORTS,
    isUuid,
    buildWhere,
    normalizeCustomerSort,
    listCustomers,
    exportRows,
    matchingCustomerIds,
    reauthorizeCustomerIds
};