'use strict';

// The report-only Plisio sweep: zero-based paging, the contract guards, and that it only ever reads.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const sweep = require('../src/payments/plisio-sweep');

const op = n => ({ txn_id: `txn-abcdefgh-${n}`, order_number: `order-${n}`, status: 'completed' });
const page = (items, { current, pages, total }) => ({ operations: items, _links: {}, _meta: { totalCount: total, pageCount: pages, currentPage: current, perPage: 50 } });

(async () => {
    // Pages start at ZERO and ask only for completed operations with limit as the page size.
    const calls = [];
    const api = async (p, params) => { calls.push({ p, params }); return params.page === 0 ? page([op(1), op(2)], { current: 1, pages: 2, total: 3 }) : page([op(3)], { current: 2, pages: 2, total: 3 }); };
    let result = await sweep.scan({ apiFn: api });
    assert.deepStrictEqual(calls.map(c => c.params.page), [0, 1], 'starts at page 0 and walks forward');
    assert(calls.every(c => c.params.limit === 50 && c.params.status === 'completed' && c.p === '/api/v1/operations'));
    assert.strictEqual(result.operations.length, 3);
    assert(!result.incomplete && !result.structural.length && !result.failed);

    // Structural contract problems.
    result = await sweep.scan({ apiFn: async () => page([op(1)], { current: 2, pages: 1, total: 1 }) });
    assert.deepStrictEqual(result.structural, ['page_base_changed'], 'the page base changing is a contract problem');
    result = await sweep.scan({ apiFn: async () => page([], { current: 1, pages: 1, total: 4 }) });
    assert.deepStrictEqual(result.structural, ['empty_first_page'], 'completed payments reported but none returned (the original bug)');
    for (const bad of [null, {}, { operations: 'x', _meta: {} }, { operations: [], _meta: null }]) {
        assert.deepStrictEqual((await sweep.scan({ apiFn: async () => bad })).structural, ['unexpected_shape']);
    }
    assert.deepStrictEqual((await sweep.scan({ apiFn: async () => ({ operations: [], _meta: { currentPage: 'x', pageCount: 1, totalCount: 0 } }) })).structural, ['unexpected_paging']);

    // Transient situations are "incomplete", never a contract problem.
    result = await sweep.scan({ apiFn: async p => page([op(1), op(1)], { current: 1, pages: 1, total: 2 }) });
    assert(result.incomplete && !result.structural.length, 'a repeated operation means the list shifted: incomplete');
    result = await sweep.scan({ apiFn: async (p, params) => page([op(params.page)], { current: params.page + 1, pages: 99, total: 99 }), maxPages: 3 });
    assert(result.incomplete && result.pages === 3 && !result.structural.length, 'more pages than one run scans is incomplete');
    result = await sweep.scan({ apiFn: async () => { const e = new Error('x'); e.providerStatus = 429; throw e; } });
    assert.strictEqual(result.failed, 429, 'a failed request is reported, not treated as an empty list');

    // Comparison with our checkouts (read-only query, injected).
    const staleOpen = new Date(Date.now() - 3600 * 1000), freshOpen = new Date();
    let sql = '';
    const queryFn = async text => { sql = text; return { rows: [
        { provider_checkout_id: 'txn-abcdefgh-1', state: 'completed', created_at: staleOpen },
        { provider_checkout_id: 'txn-abcdefgh-2', state: 'open', created_at: staleOpen },
        { provider_checkout_id: 'txn-abcdefgh-3', state: 'open', created_at: freshOpen }
    ] }; };
    const compared = await sweep.compare([op(1), op(2), op(3), op(4)].map(o => ({ id: o.txn_id })), queryFn);
    assert.deepStrictEqual(compared, { settled: 1, stuckOpen: ['txn-abcdefgh-2'], unmatched: ['txn-abcdefgh-4'] });
    assert(/^\s*SELECT/i.test(sql) && !/INSERT|UPDATE|DELETE/i.test(sql), 'the comparison only reads');

    // Full report: warnings are plain language and never grant.
    const full = await sweep.report({ apiFn: async () => page([op(1), op(2), op(4)], { current: 1, pages: 1, total: 3 }), queryFn });
    assert(full.reportOnly && full.unmatched === 1 && full.stuckOpen === 1 && full.settled === 1);
    assert(/match no checkout here/.test(full.warning) && /nothing was granted/.test(full.warning) && /still open here/.test(full.warning));
    assert(!full.warning.includes('txn-abcdefgh'), 'only a short tail of an id is shown');
    const broken = await sweep.report({ apiFn: async () => page([], { current: 1, pages: 1, total: 4 }), queryFn });
    assert(/could not run safely/.test(broken.warning) && /returned none/.test(broken.warning));
    const clean = await sweep.report({ apiFn: async () => page([op(1)], { current: 1, pages: 1, total: 1 }), queryFn: async () => ({ rows: [{ provider_checkout_id: 'txn-abcdefgh-1', state: 'completed', created_at: staleOpen }] }) });
    assert(!clean.warning, 'nothing to say when everything matches');

    // The module itself performs no writes and grants nothing.
    const source = fs.readFileSync(path.join(__dirname, '..', 'src/payments/plisio-sweep.js'), 'utf8').replace(/\/\/.*$/gm, '');
    assert(!/INSERT\s|UPDATE\s|DELETE\s|activatePurchase|confirmCheckout|recordTransaction|transaction\(/.test(source), 'report-only: no writes or grants');
    // And recovery wires it in without letting it break recovery.
    const recovery = fs.readFileSync(path.join(__dirname, '..', 'src/payments/provider-checkout-recovery.js'), 'utf8');
    assert(/plisio-sweep/.test(recovery) && /catch \(error\) \{\s*summary\.sweep/.test(recovery));
    console.log('plisio sweep smoke: ok');
})().catch(error => { console.error(error); process.exit(1); });
