'use strict';

// REPORT-ONLY discovery of Plisio payments we may not know about. It reads Plisio's list of COMPLETED operations and compares it with our
// checkout intents. It never writes to the database, never changes access, never touches the ledger or a checkout, and never grants anything:
// the list is only a hint, and a real settlement still has to go through the per-operation verification in plisio.js.
//
// Production evidence (plisio:list-shape): Plisio's `page` is ZERO-BASED on this account (page=1 answered currentPage=2 with no items),
// `limit` sets the page size, `per-page` is ignored. The scan therefore starts at page=0 and checks every answer against that contract.

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
// A payment completed at Plisio but still open here for longer than this should have been settled by checkout recovery by now.
const STALE_OPEN_MINUTES = 30;
const MAX_REPORTED = 8;

function wholeNumber(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function operationOf(raw) {
    const id = String(raw?.txn_id || raw?.id || '').trim();
    return id ? { id, orderNumber: String(raw?.order_number || raw?.params?.order_number || '').trim() } : null;
}

// Walks the completed-operations list. Returns:
//   structural: contract violations (the API no longer behaves as observed) -> a "provider contract changed" warning
//   incomplete: the list changed under us or is larger than one run scans -> try again next run, not a contract problem
//   failed:     the request itself failed (network, rate limit, bad key)
async function scan({ apiFn, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
    const result = { operations: [], structural: [], incomplete: false, failed: null, pages: 0, totalCount: null };
    const seen = new Set();
    for (let page = 0; page < maxPages; page += 1) {
        let data;
        try {
            data = await apiFn('/api/v1/operations', { page, limit: pageSize, status: 'completed' }, { quiet: true });
        } catch (error) {
            result.failed = Number(error?.providerStatus) || 'request_failed';
            return result;
        }
        const items = data && Array.isArray(data.operations) ? data.operations : null;
        const meta = data && typeof data._meta === 'object' && data._meta ? data._meta : null;
        if (!items || !meta) { result.structural.push('unexpected_shape'); return result; }
        const current = wholeNumber(meta.currentPage), pageCount = wholeNumber(meta.pageCount), total = wholeNumber(meta.totalCount);
        if (current == null || pageCount == null || total == null) { result.structural.push('unexpected_paging'); return result; }
        if (current !== page + 1) { result.structural.push('page_base_changed'); return result; }
        if (page === 0 && total > 0 && items.length === 0) { result.structural.push('empty_first_page'); return result; }
        result.pages += 1;
        result.totalCount = total;
        for (const raw of items) {
            const operation = operationOf(raw);
            if (!operation) { result.incomplete = true; continue; }
            if (seen.has(operation.id)) { result.incomplete = true; continue; }
            seen.add(operation.id);
            result.operations.push(operation);
        }
        if (page + 1 >= pageCount) {
            if (result.operations.length < total) result.incomplete = true;
            return result;
        }
        if (!items.length) { result.incomplete = true; return result; }
    }
    result.incomplete = true; // more pages than one run scans
    return result;
}

// Compares the completed operations with our checkout intents (read-only query).
async function compare(operations, queryFn) {
    const ids = operations.map(operation => operation.id);
    if (!ids.length) return { settled: 0, stuckOpen: [], unmatched: [] };
    const rows = (await queryFn(`
        SELECT provider_checkout_id, state, created_at
        FROM billing_checkout_intents
        WHERE provider='plisio' AND provider_checkout_id = ANY($1::text[])
    `, [ids])).rows;
    const byId = new Map(rows.map(row => [String(row.provider_checkout_id), row]));
    const out = { settled: 0, stuckOpen: [], unmatched: [] };
    const staleBefore = Date.now() - STALE_OPEN_MINUTES * 60000;
    for (const operation of operations) {
        const intent = byId.get(operation.id);
        if (!intent) out.unmatched.push(operation.id);
        else if (intent.state === 'completed') out.settled += 1;
        else if (intent.state === 'open' && new Date(intent.created_at).getTime() < staleBefore) out.stuckOpen.push(operation.id);
    }
    return out;
}

const short = id => `…${String(id).slice(-6)}`;
const list = ids => `${ids.slice(0, MAX_REPORTED).map(short).join(', ')}${ids.length > MAX_REPORTED ? `, +${ids.length - MAX_REPORTED} more` : ''}`;

const STRUCTURAL_TEXT = {
    unexpected_shape: 'Plisio returned a list in a shape we do not recognise',
    unexpected_paging: 'Plisio returned paging information we do not recognise',
    page_base_changed: 'Plisio no longer numbers pages from zero',
    empty_first_page: 'Plisio reports completed payments but returned none'
};

async function report({ apiFn = null, queryFn = null, pageSize = PAGE_SIZE, maxPages = MAX_PAGES } = {}) {
    const plisio = require('./plisio');
    if (!apiFn && !plisio.enabled()) return { skipped: 'plisio_not_configured' };
    const scanned = await scan({ apiFn: apiFn || plisio.api, pageSize, maxPages });
    const summary = {
        reportOnly: true, pages: scanned.pages, completedAtProvider: scanned.operations.length, totalCount: scanned.totalCount,
        incomplete: scanned.incomplete, structural: scanned.structural, failed: scanned.failed
    };
    const warnings = [];
    if (scanned.structural.length) {
        warnings.push(`Plisio payment check could not run safely: ${scanned.structural.map(code => STRUCTURAL_TEXT[code] || code).join('; ')}. Check Plisio's API or contact support.`);
        return { ...summary, warning: warnings.join(' ') };
    }
    if (scanned.failed) return summary; // transient: the normal per-payment recovery still runs
    const run = queryFn || require('../db').query;
    const compared = await compare(scanned.operations, run);
    Object.assign(summary, { settled: compared.settled, unmatched: compared.unmatched.length, stuckOpen: compared.stuckOpen.length });
    if (compared.unmatched.length) warnings.push(`${compared.unmatched.length} completed Plisio payment(s) match no checkout here (${list(compared.unmatched)}). Check them in Plisio and Admin → Billing; nothing was granted automatically.`);
    if (compared.stuckOpen.length) warnings.push(`${compared.stuckOpen.length} Plisio payment(s) are completed at Plisio but still open here (${list(compared.stuckOpen)}); checkout recovery should settle them, check it if this stays.`);
    if (warnings.length) summary.warning = warnings.join(' ');
    return summary;
}

module.exports = { PAGE_SIZE, MAX_PAGES, STALE_OPEN_MINUTES, scan, compare, report };
