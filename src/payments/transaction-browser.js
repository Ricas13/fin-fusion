'use strict';

const { query } = require('../db');
const historyAccounting = require('./history-accounting');

const PAGE_SIZE = 100;
const SCAN_BATCH = 2000;
const MAX_CLASSIFIED_SCAN = 100000;
const PROVIDERS = new Set(['all', 'stripe', 'paypal']);
const KINDS = new Set(['all', 'payment', 'refund', 'ignored']);

function clean(value, max = 320) { return String(value == null ? '' : value).trim().slice(0, max); }
function positiveInt(value, fallback = 1) { const n = Number.parseInt(value, 10); return Number.isFinite(n) && n > 0 ? n : fallback; }
function normalizeFilters(input = {}) {
    const provider = PROVIDERS.has(clean(input.provider, 20).toLowerCase()) ? clean(input.provider, 20).toLowerCase() : 'all';
    const kind = KINDS.has(clean(input.kind, 20).toLowerCase()) ? clean(input.kind, 20).toLowerCase() : 'all';
    const currency = clean(input.currency, 8).toUpperCase();
    const status = clean(input.status, 40);
    const q = clean(input.q, 200);
    const startDate = /^\d{4}-\d{2}-\d{2}$/.test(clean(input.startDate, 10)) ? clean(input.startDate, 10) : '';
    const endDate = /^\d{4}-\d{2}-\d{2}$/.test(clean(input.endDate, 10)) ? clean(input.endDate, 10) : '';
    const page = Math.min(10000, positiveInt(input.page, 1));
    return { provider, kind, currency, status, q, startDate, endDate, page };
}

function whereClause(filters, params) {
    const clauses = ['1=1'];
    const add = value => { params.push(value); return `$${params.length}`; };
    if (filters.provider !== 'all') clauses.push(`t.provider=${add(filters.provider)}`);
    if (filters.currency) clauses.push(`UPPER(t.currency)=${add(filters.currency)}`);
    if (filters.status) clauses.push(`LOWER(COALESCE(t.transaction_status,''))=LOWER(${add(filters.status)})`);
    if (filters.startDate) clauses.push(`t.occurred_at>=${add(filters.startDate)}::date`);
    if (filters.endDate) clauses.push(`t.occurred_at<(${add(filters.endDate)}::date + INTERVAL '1 day')`);
    if (filters.q) {
        const needle = `%${filters.q}%`;
        const p = add(needle);
        clauses.push(`(
            COALESCE(c.email,'') ILIKE ${p} OR COALESCE(c.display_name,'') ILIKE ${p} OR COALESCE(u.username,'') ILIKE ${p}
            OR COALESCE(t.provider_transaction_id,'') ILIKE ${p} OR COALESCE(t.provider_customer_id,'') ILIKE ${p}
            OR COALESCE(t.provider_reference_id,'') ILIKE ${p} OR COALESCE(t.provider_source_id,'') ILIKE ${p}
            OR COALESCE(t.transaction_type,'') ILIKE ${p}
        )`);
    }
    return clauses.join(' AND ');
}

function rowSelect() {
    return `SELECT t.id,t.provider,t.provider_transaction_id,t.transaction_type,t.transaction_status,t.occurred_at,t.currency,
                   t.gross_amount_minor,t.fee_amount_minor,t.net_amount_minor,t.provider_customer_id,t.provider_reference_id,
                   t.provider_source_id,t.customer_id,t.metadata,
                   COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) AS customer_email,
                   c.display_name,u.username AS portal_username
              FROM payment_history_transactions t
              LEFT JOIN customers c ON c.id=t.customer_id
              LEFT JOIN app_users u ON u.id=c.user_id`;
}

function classify(row) { return historyAccounting.historyKind(row) || 'ignored'; }

async function fetchBase(filters, limit, offset) {
    const params = [];
    const where = whereClause(filters, params);
    params.push(limit, offset);
    return query(`${rowSelect()} WHERE ${where} ORDER BY t.occurred_at DESC,t.id DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
}

async function baseCount(filters) {
    const params = [];
    const where = whereClause(filters, params);
    const result = await query(`SELECT COUNT(*)::bigint AS total FROM payment_history_transactions t LEFT JOIN customers c ON c.id=t.customer_id LEFT JOIN app_users u ON u.id=c.user_id WHERE ${where}`, params);
    return Number(result.rows[0]?.total || 0);
}

async function listTransactions(input = {}) {
    const filters = normalizeFilters(input);
    const start = (filters.page - 1) * PAGE_SIZE;
    if (filters.kind === 'all') {
        const [total, page] = await Promise.all([baseCount(filters), fetchBase(filters, PAGE_SIZE, start)]);
        const rows = page.rows.map(row => ({ ...row, kind: classify(row) }));
        return { filters, rows, total, page: filters.page, pageSize: PAGE_SIZE, hasNext: start + rows.length < total, truncated: false };
    }

    const wanted = filters.kind;
    const rows = [];
    let offset = 0, matched = 0, scanned = 0, exhausted = false;
    while (!exhausted && scanned < MAX_CLASSIFIED_SCAN) {
        const batch = await fetchBase(filters, SCAN_BATCH, offset);
        if (!batch.rows.length) break;
        for (const raw of batch.rows) {
            const row = { ...raw, kind: classify(raw) };
            if (row.kind !== wanted) continue;
            if (matched >= start && rows.length < PAGE_SIZE) rows.push(row);
            matched += 1;
        }
        scanned += batch.rows.length;
        offset += batch.rows.length;
        exhausted = batch.rows.length < SCAN_BATCH;
    }
    const truncated = !exhausted && scanned >= MAX_CLASSIFIED_SCAN;
    return { filters, rows, total: matched, page: filters.page, pageSize: PAGE_SIZE, hasNext: truncated || matched > start + rows.length, truncated, scanned };
}

async function coverage() {
    const result = await query(`
        SELECT provider,COUNT(*)::bigint AS transactions,MIN(occurred_at) AS first_at,MAX(occurred_at) AS last_at,
               ARRAY_AGG(DISTINCT UPPER(currency) ORDER BY UPPER(currency)) AS currencies
          FROM payment_history_transactions
         GROUP BY provider
         ORDER BY provider
    `);
    return result.rows;
}

module.exports = { PAGE_SIZE, MAX_CLASSIFIED_SCAN, normalizeFilters, classify, listTransactions, coverage };
