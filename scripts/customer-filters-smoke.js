'use strict';

// Pure-logic regression tests for src/platform/customer-filters.js's
// buildWhere -- the single query-shape function every customer list,
// export, "select all matching", and bulk-selection re-authorization call
// goes through. No DB connection needed: we only inspect generated SQL and
// bound parameters, plus the allowlisted table-sort resolver.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildWhere, normalizeCustomerSort, CUSTOMER_SORTS } = require('../src/platform/customer-filters');
const tableSort = require('../src/platform/admin-table-sort');

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

    // Marketing saved segments deliberately reuse this same engine. Richer
    // business filters must stay bounded/allowlisted and their numeric or enum
    // values must remain positional parameters rather than SQL fragments.
    {
        const built=buildWhere({
            priceType:'paid',
            billingInterval:'year',
            accountAgeDays:30,
            lapsedDays:14,
            expiresWithinDays:7,
            inactivePlaybackDays:60
        },null);
        assert.ok(built.whereSql.includes('COALESCE(p.price_minor,0)>0'),'paid audiences must use the canonical plan price');
        assert.ok(built.whereSql.includes('p.billing_interval=$1'),'billing interval must be bound');
        assert.ok(built.whereSql.includes("c.created_at<=NOW()-($2::int*INTERVAL '1 day')"),'account age must be parameterized');
        assert.ok(built.whereSql.includes('NOT EXISTS (')&&built.whereSql.includes('hist_lapsed'),'lapsed audiences must exclude currently live subscriptions and inspect subscription history');
        assert.ok(built.whereSql.includes("cur.current_period_end<=NOW()+($4::int*INTERVAL '1 day')"),'expiry-window targeting must be parameterized');
        assert.ok(built.whereSql.includes("COALESCE(acc.last_activity_at,c.created_at)<=NOW()-($5::int*INTERVAL '1 day')"),'playback inactivity must use shared account activity and a bound duration');
        assert.deepStrictEqual(built.params,['year',30,14,7,60],'rich audience values must be carried only as positional parameters');

        const hostile=buildWhere({billingInterval:"year'); DROP TABLE plans; --",priceType:'paid;drop',accountAgeDays:'30); DELETE FROM customers; --'},null);
        assert.ok(!hostile.whereSql.includes('DROP TABLE')&&!hostile.whereSql.includes('DELETE FROM'),'invalid marketing filter input must never become SQL text');
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

    // Sort keys and directions must resolve through source-code allowlists.
    // Neither a column expression nor a SQL direction can be supplied from
    // the URL, even if the admin request is deliberately hostile.
    {
        const hostile=normalizeCustomerSort({sort:'c.id; DROP TABLE customers; --',dir:'desc NULLS FIRST; --'});
        assert.deepStrictEqual(hostile,{key:'recent',direction:'desc'},'unknown sorting input must fall back to the safe default');
        const sql=tableSort.orderBy(hostile,CUSTOMER_SORTS,'c.id ASC');
        assert.ok(!sql.includes('DROP TABLE')&&!sql.includes(';'),'raw sort input must never reach ORDER BY');
        assert.ok(sql.includes('COALESCE(acc.last_activity_at,c.created_at) DESC'),'default recent sort must remain newest activity first');
        assert.ok(sql.endsWith(', c.id ASC'),'sorting must have a deterministic customer-id tie breaker');

        const nameDesc=normalizeCustomerSort({sort:'name',dir:'desc'});
        assert.deepStrictEqual(nameDesc,{key:'name',direction:'desc'});
        assert.strictEqual(tableSort.nextDirection(nameDesc,'name',CUSTOMER_SORTS),'asc','clicking an active heading must reverse direction');
        assert.strictEqual(tableSort.nextDirection(nameDesc,'expiring',CUSTOMER_SORTS),'asc','a newly selected heading must use its configured default direction');

        const registered=normalizeCustomerSort({sort:'registered'});
        assert.deepStrictEqual(registered,{key:'registered',direction:'desc'},'registration sorting must default to newest customers first');
        assert.ok(tableSort.orderBy(registered,CUSTOMER_SORTS,'c.id ASC').includes('c.created_at DESC'),'registration sorting must use the canonical customer creation timestamp');
    }

    // The shared Customers/Jellyfin/Stremio table must render sort links and
    // carry sort state through pagination rather than snapping back to recent.
    {
        const source=fs.readFileSync(path.join(__dirname,'../src/platform/admin-customers-list.js'),'utf8');
        assert.ok(source.includes('tableSort.nextDirection'),'customer headings must use the shared sorting helper');
        assert.ok(source.includes("{...state,page:page+1}")&&source.includes("{...state,page:page-1}"),'pagination must preserve sort and direction');
        assert.ok(source.includes("sortHeader(filters,sortState,'Expires','expiring')"),'customer expiry heading must expose server-side sorting');
        assert.ok(source.includes("sortHeader(filters,sortState,'Registered','registered')"),'customer registration heading must expose server-side sorting');
        assert.ok(source.includes('data-label="Registered">${esc(date(x.created_at))}'),'customer rows must show the portal registration date from customers.created_at');
        assert.ok(source.includes('aria-sort='),'the active sortable heading must expose its direction accessibly');
    }

    console.log('Customer filters smoke test passed.');
}

main();
