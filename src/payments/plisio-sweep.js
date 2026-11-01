'use strict';

// REPORT-ONLY discovery of Plisio payments that are completed at Plisio but not settled here. It runs as its own small job
// (plisio_payment_sweep, non-critical, every 10 minutes), separate from checkout recovery so it can never delay recovery.
// It reads Plisio's list of COMPLETED operations and compares it with our checkout intents and ledger. It never writes to the database,
// never changes access, never touches the ledger or a checkout, and never grants anything: the list is only a hint, and a real
// settlement still has to go through the per-operation verification in plisio.js.
//
// Production evidence (plisio:list-shape): Plisio's `page` is ZERO-BASED on this account (page=1 answered currentPage=2 with no items),
// `limit` sets the page size, `per-page` is ignored. The scan therefore starts at page=0 and checks every answer against that contract.

const PAGE_SIZE = 50;
const MAX_PAGES = 10;
const REQUEST_TIMEOUT_MS = 10000;
const TIME_BUDGET_MS = 60000; // the whole scan, however many pages
// A payment we keep seeing as completed at Plisio but unsettled here for this long (two or more sweeps) is worth a warning.
const GRACE_MINUTES = 20;
const MAX_REPORTED = 8;
const MAX_TRACKED = 500;

function wholeNumber(value) {
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 ? number : null;
}

function operationOf(raw) {
    const id = String(raw?.txn_id || raw?.id || '').trim();
    return id ? { id, orderNumber: String(raw?.order_number || raw?.params?.order_number || '').trim() } : null;
}

// Walks the completed-operations list. Returns:
//   structural: contract violations (the API no longer behaves as observed) -> a "could not run safely" warning
//   incomplete: the list changed under us, is larger than one run scans, or the time budget ran out -> a partial observation
//   failed:     the request itself failed (network, rate limit, bad key)
async function scan({ apiFn, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, budgetMs = TIME_BUDGET_MS, now = Date.now } = {}) {
    const result = { operations: [], structural: [], incomplete: false, failed: null, pages: 0, totalCount: null };
    const seen = new Set();
    const deadline = now() + budgetMs;
    for (let page = 0; page < maxPages; page += 1) {
        if (page > 0 && now() >= deadline) { result.incomplete = true; return result; }
        let data;
        try {
            data = await apiFn('/api/v1/operations', { page, limit: pageSize, status: 'completed' }, { quiet: true, timeoutMs: REQUEST_TIMEOUT_MS });
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
        if (total === 0 && items.length > 0) { result.structural.push('unexpected_paging'); return result; }
        result.pages += 1;
        result.totalCount = total;
        for (const raw of items) {
            // If Plisio ever ignores the status filter, only completed operations are of interest here.
            if (raw && raw.status != null && String(raw.status).toLowerCase() !== 'completed') continue;
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

// Read-only comparison with our checkout intents and ledger. Each operation is one of:
//   settled   : the checkout is completed, or the payment is already in the ledger
//   unmatched : no checkout and no ledger row
//   pending   : checkout still open
//   closed    : checkout was closed locally (failed / expired / cancelled) although Plisio says it completed
async function compare(operations, queryFn) {
    const out = { settled: [], unmatched: [], pending: [], closed: [] };
    const ids = operations.map(operation => operation.id);
    if (!ids.length) return out;
    const intents = (await queryFn(`
        SELECT provider_checkout_id, state FROM billing_checkout_intents
        WHERE provider='plisio' AND provider_checkout_id = ANY($1::text[])
    `, [ids])).rows;
    const inLedger = await require('./provider-financial-state').knownTransactionIds('plisio', ids, { queryFn });
    const stateById = new Map(intents.map(row => [String(row.provider_checkout_id), String(row.state)]));
    for (const id of ids) {
        const state = stateById.get(id);
        if (state === 'completed') out.settled.push(id);
        else if (state === 'open') out.pending.push(id);
        else if (state) out.closed.push(id);
        else if (inLedger.has(id)) out.settled.push(id);
        else out.unmatched.push(id);
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

// First time each unsettled payment was seen by THIS worker process, so a payment that is simply being settled by the normal recovery
// (every 5 minutes) is not flagged. A restart only restarts the grace period; the sweep is report-only so this is harmless.
const firstSeen = new Map();
function longUnsettled(ids, at) {
    const live = new Set(ids);
    for (const id of [...firstSeen.keys()]) if (!live.has(id)) firstSeen.delete(id);
    const old = [];
    for (const id of ids) {
        if (!firstSeen.has(id) && firstSeen.size < MAX_TRACKED) firstSeen.set(id, at);
        if (firstSeen.has(id) && at - firstSeen.get(id) >= GRACE_MINUTES * 60000) old.push(id);
    }
    return old;
}

async function report({ apiFn = null, queryFn = null, pageSize = PAGE_SIZE, maxPages = MAX_PAGES, budgetMs = TIME_BUDGET_MS, now = Date.now } = {}) {
    const plisio = require('./plisio');
    if (!apiFn && !plisio.enabled()) return { skipped: 'plisio_not_configured' };
    const scanned = await scan({ apiFn: apiFn || plisio.api, pageSize, maxPages, budgetMs, now });
    const summary = {
        reportOnly: true, pages: scanned.pages, completedAtProvider: scanned.operations.length, totalCount: scanned.totalCount,
        partial: scanned.incomplete, structural: scanned.structural, failed: scanned.failed
    };
    if (scanned.structural.length) {
        summary.warning = `Plisio payment check could not run safely: ${scanned.structural.map(code => STRUCTURAL_TEXT[code] || code).join('; ')}. Check Plisio's API or contact support.`;
        return summary;
    }
    if (scanned.failed) return summary; // the caller decides how a failed request is surfaced
    const run = queryFn || require('../db').query;
    const compared = await compare(scanned.operations, run);
    const pendingOld = longUnsettled([...compared.pending, ...compared.closed], now());
    const partial = scanned.incomplete ? ' (partial scan: more may exist)' : '';
    Object.assign(summary, { settled: scanned.incomplete ? undefined : compared.settled.length, unmatched: compared.unmatched.length, pending: compared.pending.length, closed: compared.closed.length });
    const warnings = [];
    if (compared.unmatched.length) warnings.push(`${compared.unmatched.length} completed Plisio payment(s) match no checkout here (${list(compared.unmatched)})${partial}. Check them in Plisio and Admin → Billing; nothing was granted automatically.`);
    const closedOld = compared.closed.filter(id => pendingOld.includes(id));
    if (closedOld.length) warnings.push(`${closedOld.length} Plisio payment(s) are completed at Plisio but the checkout here was closed without access (${list(closedOld)})${partial}. Check each customer; nothing was granted automatically.`);
    const openOld = compared.pending.filter(id => pendingOld.includes(id));
    if (openOld.length) warnings.push(`${openOld.length} Plisio payment(s) are completed at Plisio but still open here for over ${GRACE_MINUTES} minutes (${list(openOld)})${partial}. Checkout recovery should settle them; check it if this stays.`);
    if (warnings.length) summary.warning = warnings.join(' ');
    return summary;
}

// The scheduled job. Warnings surface as a degraded job with the warning text (job-health counts `failed`); a failed request throws so the
// job shows as failed with the reason and retries on the normal back-off. Nothing here can touch payments or access.
async function runJob() {
    const summary = await report();
    if (summary.failed) throw new Error(`Plisio payment list request failed (${summary.failed}).`);
    const warned = summary.warning ? 1 : 0;
    return { ...summary, processed: Number(summary.completedAtProvider || 0), failed: warned, ...(warned ? { warning: summary.warning } : {}) };
}

module.exports = { PAGE_SIZE, MAX_PAGES, TIME_BUDGET_MS, GRACE_MINUTES, scan, compare, report, runJob };
