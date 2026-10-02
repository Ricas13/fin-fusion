'use strict';

const historyAccounting = require('./history-accounting');
const financialState = require('./provider-financial-state');

const PAGE_SIZE = 100;
const SCAN_BATCH = 2000;
const MAX_CLASSIFIED_SCAN = 100000;
const PROVIDERS = new Set(['all', ...financialState.PROVIDERS]);
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

function classify(row) { return historyAccounting.historyKind(row) || 'ignored'; }

async function fetchBase(filters, limit, offset, customerId = null) {
    return financialState.queryTransactions(
        { provider:filters.provider,currency:filters.currency,status:filters.status,q:filters.q,startDate:filters.startDate,endDate:filters.endDate,customerId },
        { limit, offset, order:'desc' }
    );
}

async function baseCount(filters, customerId = null) {
    return financialState.countTransactions({
        provider:filters.provider,currency:filters.currency,status:filters.status,q:filters.q,
        startDate:filters.startDate,endDate:filters.endDate,customerId
    });
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

async function customerTransactions(customerId, input = {}) {
    const id = String(customerId || '').trim();
    if (!id) return { rows: [], total: 0, page: 1, pageSize: PAGE_SIZE, hasNext: false };
    const filters = normalizeFilters(input);
    const start = (filters.page - 1) * PAGE_SIZE;
    const [total, page] = await Promise.all([
        baseCount(filters,id),
        fetchBase(filters,PAGE_SIZE,start,id)
    ]);
    const rows = page.rows.map(row => ({ ...row, kind: classify(row) })).filter(row => row.kind !== 'ignored');
    return { filters, rows, total, page: filters.page, pageSize: PAGE_SIZE, hasNext: start + page.rows.length < total };
}

async function coverage() {
    return financialState.transactionCoverage();
}

module.exports = { PAGE_SIZE, MAX_CLASSIFIED_SCAN, normalizeFilters, classify, listTransactions, customerTransactions, coverage };
