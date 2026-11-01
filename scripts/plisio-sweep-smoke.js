'use strict';

// The report-only Plisio sweep: zero-based paging, contract guards, terminal checkouts, grace period, partial scans, job result, no writes.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sweep = require('../src/payments/plisio-sweep');

const ID = n => `txn-abcdefgh-${n}`;
const op = n => ({ txn_id: ID(n), order_number: `order-${n}`, status: 'completed' });
const page = (items, { current, pages, total }) => ({ operations: items, _links: {}, _meta: { totalCount: total, pageCount: pages, currentPage: current, perPage: 50 } });
const read = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');

(async () => {
    // Pages start at ZERO and ask only for completed operations; the scan has a request timeout.
    const calls = [];
    const api = async (p, params, options) => { calls.push({ p, params, options }); return params.page === 0 ? page([op(1), op(2)], { current: 1, pages: 2, total: 3 }) : page([op(3)], { current: 2, pages: 2, total: 3 }); };
    let result = await sweep.scan({ apiFn: api });
    assert.deepStrictEqual(calls.map(c => c.params.page), [0, 1]);
    assert(calls.every(c => c.params.limit === 50 && c.params.status === 'completed' && c.p === '/api/v1/operations' && c.options.timeoutMs <= 10000 && c.options.quiet));
    assert.strictEqual(result.operations.length, 3);
    assert(!result.incomplete && !result.structural.length && !result.failed);

    // Structural contract problems.
    assert.deepStrictEqual((await sweep.scan({ apiFn: async () => page([op(1)], { current: 2, pages: 1, total: 1 }) })).structural, ['page_base_changed']);
    assert.deepStrictEqual((await sweep.scan({ apiFn: async () => page([], { current: 1, pages: 1, total: 4 }) })).structural, ['empty_first_page']);
    assert.deepStrictEqual((await sweep.scan({ apiFn: async () => page([op(1)], { current: 1, pages: 1, total: 0 }) })).structural, ['unexpected_paging'], 'a zero total with records is inconsistent');
    for (const bad of [null, {}, { operations: 'x', _meta: {} }, { operations: [], _meta: null }]) assert.deepStrictEqual((await sweep.scan({ apiFn: async () => bad })).structural, ['unexpected_shape']);
    assert.deepStrictEqual((await sweep.scan({ apiFn: async () => ({ operations: [], _meta: { currentPage: 'x', pageCount: 1, totalCount: 0 } }) })).structural, ['unexpected_paging']);

    // If Plisio ignores the status filter, only completed operations are used.
    result = await sweep.scan({ apiFn: async () => page([op(1), { txn_id: ID(9), status: 'expired' }, { txn_id: ID(8), status: 'NEW' }], { current: 1, pages: 1, total: 3 }) });
    assert.deepStrictEqual(result.operations.map(o => o.id), [ID(1)]);

    // Transient situations are "incomplete", never structural; failures are failures, never an empty list.
    result = await sweep.scan({ apiFn: async () => page([op(1), op(1)], { current: 1, pages: 1, total: 2 }) });
    assert(result.incomplete && !result.structural.length);
    result = await sweep.scan({ apiFn: async (p, params) => page([op(params.page)], { current: params.page + 1, pages: 99, total: 99 }), maxPages: 3 });
    assert(result.incomplete && result.pages === 3 && !result.structural.length);
    result = await sweep.scan({ apiFn: async () => { const e = new Error('x'); e.providerStatus = 429; throw e; } });
    assert.strictEqual(result.failed, 429);
    // Time budget: stops between pages, never mid-request, and says it is partial.
    let clock = 0;
    result = await sweep.scan({ apiFn: async (p, params) => { clock += 40000; return page([op(params.page)], { current: params.page + 1, pages: 50, total: 50 }); }, now: () => clock, budgetMs: 60000 });
    assert(result.incomplete && result.pages === 2, `the scan stops once the time budget is spent (${result.pages} pages)`);

    // Comparison: settled (checkout or ledger), unmatched, pending, closed. Read-only queries.
    const sqls = [];
    const intents = [{ provider_checkout_id: ID(1), state: 'completed' }, { provider_checkout_id: ID(2), state: 'open' }, { provider_checkout_id: ID(3), state: 'expired' }, { provider_checkout_id: ID(6), state: 'failed' }, { provider_checkout_id: ID(7), state: 'cancelled' }];
    const queryFn = async text => { sqls.push(text); return /billing_checkout_intents/.test(text) ? { rows: intents } : { rows: [{ provider_transaction_id: ID(5) }] }; };
    const ops = [1, 2, 3, 4, 5, 6, 7].map(n => ({ id: ID(n) }));
    const compared = await sweep.compare(ops, queryFn);
    assert.deepStrictEqual(compared, { settled: [ID(1), ID(5)], unmatched: [ID(4)], pending: [ID(2)], closed: [ID(3), ID(6), ID(7)] });
    assert(sqls.every(text => /^\s*SELECT/i.test(text) && !/INSERT|UPDATE|DELETE/i.test(text)), 'the comparisons only read');

    // Full report: terminal checkouts are reported; the grace period suppresses normal in-flight settlement; partial scans are labelled.
    let clockNow = 1_000_000;
    const base = { apiFn: async () => page([1, 2, 3, 4].map(op), { current: 1, pages: 1, total: 4 }), queryFn, now: () => clockNow };
    let first = await sweep.report(base);
    assert(first.reportOnly && first.unmatched === 1 && first.closed === 1 && first.pending === 1);
    assert(/match no checkout here/.test(first.warning) && /nothing was granted/.test(first.warning), 'unmatched is reported at once');
    assert(!/closed without access/.test(first.warning) && !/still open here/.test(first.warning), 'closed / open payments get a grace period first');
    clockNow += 21 * 60000;
    const later = await sweep.report(base);
    assert(/closed without access/.test(later.warning) && /still open here for over 20 minutes/.test(later.warning), 'after the grace period both are reported');
    assert(!later.warning.includes('txn-abcdefgh'), 'only a short id tail is shown');
    // Once settled, nothing remains tracked.
    intents[1].state = 'completed'; intents[2].state = 'completed';
    const settled = await sweep.report({ ...base, apiFn: async () => page([op(1), op(2), op(3)], { current: 1, pages: 1, total: 3 }) });
    assert(!settled.warning);
    // A partial scan says so and gives no definitive "settled" count.
    const partial = await sweep.report({ ...base, apiFn: async () => page([op(4)], { current: 1, pages: 9, total: 400 }), maxPages: 1 });
    assert(partial.partial && partial.settled === undefined && /partial scan/.test(partial.warning));
    const broken = await sweep.report({ ...base, apiFn: async () => page([], { current: 1, pages: 1, total: 4 }) });
    assert(/could not run safely/.test(broken.warning) && /returned none/.test(broken.warning));

    // The scheduled job: warnings become a degraded run (failed + warning), a failed request throws, a clean run is quiet.
    const jobs = read('src/automation/jobs.js');
    assert(/plisio_payment_sweep:\{defaultIntervalSeconds:600,critical:false\}/.test(jobs) && /async plisio_payment_sweep\(\)\{return require\('\.\.\/payments\/plisio-sweep'\)\.runJob\(\)\}/.test(jobs));
    assert(!/plisio-sweep/.test(read('src/payments/provider-checkout-recovery.js')), 'recovery never runs or waits for the sweep');
    assert(/plisio_payment_sweep/.test(read('src/platform/admin-automation.js')));
    const plisioModule = require('../src/payments/plisio');
    const realApi = plisioModule.api, realEnabled = plisioModule.enabled;
    const db = require('../src/db'), realQuery = db.query;
    try {
        plisioModule.enabled = () => true;
        db.query = queryFn;
        plisioModule.api = async () => page([op(4)], { current: 1, pages: 1, total: 1 });
        const warned = await sweep.runJob();
        assert(warned.failed === 1 && /match no checkout here/.test(warned.warning) && warned.processed === 1, 'a warning is a degraded job run with its text');
        plisioModule.api = async () => page([op(1)], { current: 1, pages: 1, total: 1 });
        const clean = await sweep.runJob();
        assert(clean.failed === 0 && !clean.warning);
        plisioModule.api = async () => { const e = new Error('x'); e.providerStatus = 429; throw e; };
        await assert.rejects(sweep.runJob(), /request failed \(429\)/);
        plisioModule.enabled = () => false;
        assert.deepStrictEqual(await sweep.runJob(), { skipped: 'plisio_not_configured', processed: 0, failed: 0 });
    } finally { plisioModule.api = realApi; plisioModule.enabled = realEnabled; db.query = realQuery; }

    // Report-only: the module has no writes or grants.
    const source = read('src/payments/plisio-sweep.js').replace(/\/\/.*$/gm, '');
    assert(!/INSERT\s|UPDATE\s|DELETE\s|activatePurchase|confirmCheckout|recordTransaction|transaction\(/.test(source));
    console.log('plisio sweep smoke: ok');
})().catch(error => { console.error(error); process.exit(1); });
