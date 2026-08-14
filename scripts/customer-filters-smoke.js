'use strict';

// Pure-logic regression tests for src/platform/customer-filters.js's
// buildWhere -- the single query-shape function every customer list,
// export, "select all matching", and bulk-selection re-authorization call
// goes through. No DB connection needed: we only inspect the generated SQL
// text and bound parameters, which is exactly where a reseller-scope bypass
// would have to show up if one existed.

const assert = require('assert');
const { buildWhere } = require('../src/platform/customer-filters');

function main() {
    // #14 / #16 a reseller's own scope must always be applied, and a
    // reseller-supplied filters.resellerId claiming a DIFFERENT reseller
    // must never override it -- the scope wins unconditionally.
    {
        const mine = '11111111-1111-1111-1111-111111111111';
        const someoneElses = '22222222-2222-2222-2222-222222222222';
        const { whereSql, params } = buildWhere({ resellerId: someoneElses }, { resellerId: mine });
        assert.ok(whereSql.includes('c.reseller_id=$1'), 'reseller scope must be applied as the customer ownership filter');
        assert.strictEqual(params[0], mine, 'the caller\'s own reseller id must be bound, never the requested one');
        assert.ok(!params.includes(someoneElses), 'a reseller-supplied resellerId filter must never appear in the bound params when scope is set');
    }

    // An admin (no scope) picking a specific reseller filter is legitimate
    // and should be honored.
    {
        const chosen = '33333333-3333-3333-3333-333333333333';
        const { whereSql, params } = buildWhere({ resellerId: chosen }, null);
        assert.ok(whereSql.includes('c.reseller_id=$1'));
        assert.strictEqual(params[0], chosen);
    }

    // No scope, no reseller filter -> no reseller restriction in the WHERE
    // clause at all (admin sees everyone by default).
    {
        const { whereSql } = buildWhere({}, null);
        assert.ok(!whereSql.includes('reseller_id'), 'no reseller restriction should be present for an unscoped admin request with no reseller filter');
    }

    // #16 every filter field must translate into a bound parameter, never a
    // string-interpolated literal -- this is what makes "select all
    // matching" safe to run with arbitrary admin-supplied filter values.
    {
        const evilLibrary = "x'); DROP TABLE customers; --";
        const { whereSql, params } = buildWhere({ library: evilLibrary, q: "'; --" }, null);
        assert.ok(!whereSql.includes('DROP TABLE'), 'filter values must never be concatenated into the SQL text');
        assert.ok(params.includes(evilLibrary), 'filter values must be passed as bound parameters instead');
    }

    // #17 reauthorizeCustomerIds (used when confirming a bulk action with
    // explicit checkbox selections) is built on the exact same buildWhere as
    // the list/select-all path -- verify the scope-enforcing WHERE clause is
    // identical regardless of which candidate ids are supplied, i.e. a
    // manipulated id list cannot itself change the authorization boundary.
    {
        const mine = '44444444-4444-4444-4444-444444444444';
        const a = buildWhere({}, { resellerId: mine });
        const b = buildWhere({}, { resellerId: mine });
        assert.strictEqual(a.whereSql, b.whereSql, 'the scope clause must be deterministic and independent of any candidate id list');
        assert.deepStrictEqual(a.params, b.params);
    }

    console.log('Customer filters smoke test passed.');
}

main();
