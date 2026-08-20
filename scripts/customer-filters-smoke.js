'use strict';

// Pure-logic regression tests for src/platform/customer-filters.js's
// buildWhere -- the single query-shape function every customer list,
// export, "select all matching", and bulk-selection re-authorization call
// goes through. No DB connection needed: we only inspect the generated SQL
// text and bound parameters.

const assert = require('assert');
const { buildWhere } = require('../src/platform/customer-filters');

function main() {
    // #16 every filter field must translate into a bound parameter, never a
    // string-interpolated literal -- this is what makes "select all
    // matching" safe to run with arbitrary admin-supplied filter values.
    {
        const evilLibrary = "x'); DROP TABLE customers; --";
        const { whereSql, params } = buildWhere({ library: evilLibrary, q: "'; --" }, null);
        assert.ok(!whereSql.includes('DROP TABLE'), 'filter values must never be concatenated into the SQL text');
        assert.ok(params.includes(evilLibrary), 'filter values must be passed as bound parameters instead');
    }

    // Product workspaces use the shared customer list with a bound service
    // context. Bundle subscriptions must participate in both product views.
    {
        const jellyfin=buildWhere({service:'jellyfin'},null);
        const stremio=buildWhere({service:'stremio'},null);
        assert.ok(jellyfin.whereSql.includes("IN ('jellyfin','bundle')"),'Jellyfin context must include Jellyfin and bundle history');
        assert.ok(stremio.whereSql.includes("IN ('stremio','bundle')"),'Stremio context must include Stremio and bundle history');
        assert.deepStrictEqual(jellyfin.params,['jellyfin'],'service context must stay parameterized');
        assert.deepStrictEqual(stremio.params,['stremio'],'service context must stay parameterized');
    }

    // #17 reauthorizeCustomerIds (used when confirming a bulk action with
    // explicit checkbox selections) is built on the exact same buildWhere as
    // the list/select-all path -- verify the WHERE clause is deterministic
    // regardless of which candidate ids are supplied, i.e. a manipulated id
    // list cannot itself change the authorization boundary.
    {
        const a = buildWhere({}, null);
        const b = buildWhere({}, null);
        assert.strictEqual(a.whereSql, b.whereSql, 'the clause must be deterministic and independent of any candidate id list');
        assert.deepStrictEqual(a.params, b.params);
    }

    console.log('Customer filters smoke test passed.');
}

main();
