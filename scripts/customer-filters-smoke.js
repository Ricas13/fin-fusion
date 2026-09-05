'use strict';

// Pure-logic regression tests for the shared Customers query/filter contract.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { buildWhere, normalizeCustomerSort, CUSTOMER_SORTS } = require('../src/platform/customer-filters');
const tableSort = require('../src/platform/admin-table-sort');

function main() {
    {
        const evilLibrary = "x'); DROP TABLE customers; --";
        const { whereSql, params } = buildWhere({ library: evilLibrary, q: "'; --" }, null);
        assert.ok(!whereSql.includes('DROP TABLE'), 'filter values must never be concatenated into SQL');
        assert.ok(params.includes(evilLibrary), 'filter values must stay bound');
    }

    {
        const jellyfin=buildWhere({service:'jellyfin'},null);
        const stremio=buildWhere({service:'stremio'},null);
        assert.ok(jellyfin.whereSql.includes("IN ('jellyfin','bundle')"),'Jellyfin context must include bundle history');
        assert.ok(stremio.whereSql.includes("IN ('stremio','bundle')"),'Stremio context must include bundle history');
        assert.deepStrictEqual(jellyfin.params,['jellyfin']);
        assert.deepStrictEqual(stremio.params,['stremio']);
    }

    {
        const built=buildWhere({priceType:'paid',billingInterval:'year',accountAgeDays:30,lapsedDays:14,expiresWithinDays:7,inactivePlaybackDays:60},null);
        assert.ok(built.whereSql.includes('COALESCE(p.price_minor,0)>0'),'paid audiences must use canonical plan price');
        assert.ok(built.whereSql.includes('p.billing_interval=$1'),'billing interval must be bound');
        assert.ok(built.whereSql.includes("c.created_at<=NOW()-($2::int*INTERVAL '1 day')"),'account age must be parameterized');
        assert.ok(built.whereSql.includes('hist_lapsed'),'lapsed audiences must inspect subscription history');
        assert.ok(built.whereSql.includes("cur.current_period_end<=NOW()+($4::int*INTERVAL '1 day')"),'expiry targeting must be parameterized');
        assert.ok(built.whereSql.includes('FROM playback_history ph_segment'),'playback inactivity must use canonical playback history');
        assert.deepStrictEqual(built.params,['year',30,14,7,60]);
    }

    // Operational access filters must describe the binary Jellyfin lifecycle.
    {
        const active=buildWhere({access:'active'},null);
        const attention=buildWhere({access:'attention'},null);
        const expired=buildWhere({access:'expired'},null);
        assert.ok(active.whereSql.includes("cur.status IN ('active','trialing')"),'active filter must require a live entitlement');
        assert.ok(active.whereSql.includes('customer_account_count'),'live Jellyfin/bundle access must require a present customer Jellyfin identity');
        assert.ok(attention.whereSql.includes("cur.status='past_due'")&&attention.whereSql.includes('recon.rank'),'attention filter must combine commerce and provisioning faults');
        assert.ok(expired.whereSql.includes("cur.status IN ('expired','cancelled')"),'expired filter must use entitlement lifecycle');
        const legacy=buildWhere({accountStatus:'disabled'},null);
        assert.ok(!legacy.whereSql.includes('has_enabled_account'),'legacy Jellyfin disabled filtering must not return as a valid lifecycle state');
    }

    {
        const hostile=normalizeCustomerSort({sort:'c.id; DROP TABLE customers; --',dir:'desc NULLS FIRST; --'});
        assert.deepStrictEqual(hostile,{key:'attention',direction:'asc'},'unknown sorting input must fall back to attention-first');
        const sql=tableSort.orderBy(hostile,CUSTOMER_SORTS,'c.id ASC');
        assert.ok(!sql.includes('DROP TABLE')&&!sql.includes(';'),'raw sort input must never reach ORDER BY');
        assert.ok(sql.includes('CASE WHEN'),'default customer sort must prioritize actionable rows');

        const nameDesc=normalizeCustomerSort({sort:'name',dir:'desc'});
        assert.deepStrictEqual(nameDesc,{key:'name',direction:'desc'});
        assert.strictEqual(tableSort.nextDirection(nameDesc,'name',CUSTOMER_SORTS),'asc');
        assert.strictEqual(tableSort.nextDirection(nameDesc,'expiring',CUSTOMER_SORTS),'asc');
    }

    // The visible table and filters must match the operator workflow rather
    // than exposing implementation columns or the retired disabled state.
    {
        const source=fs.readFileSync(path.join(__dirname,'../src/platform/admin-customers-list.js'),'utf8');
        const bulk=fs.readFileSync(path.join(__dirname,'../public/js/admin-customers-bulk.js'),'utf8');
        assert.ok(source.includes("sortHeader(filters,sortState,'Access','access')"),'Access must be a first-class sortable column');
        assert.ok(source.includes("sortHeader(filters,sortState,'Service / Server','server')"),'service and placement must be one scan-friendly column');
        assert.ok(source.includes("sortHeader(filters,sortState,'Expires / Renews','expiring')"),'commercial timing must be visible');
        assert.ok(source.includes("sortHeader(filters,sortState,'Last active','recent')"),'last activity must be visible');
        assert.ok(source.includes("sortHeader(filters,sortState,'Attention','attention')"),'attention must be sortable');
        assert.ok(!source.includes("sortHeader(filters,sortState,'Registered','registered')"),'registration date must not occupy the default table');
        assert.ok(!source.includes('Jellyfin disabled'),'the retired Jellyfin disabled state must not be exposed by filters or overview copy');
        for(const preset of ['Needs attention','Active','Trials','Free','Paid','No plan'])assert.ok(source.includes(preset),`quick preset missing: ${preset}`);
        for(const advanced of ['Payment provider','Subscription status','Customer settings','Library','Registered from','Registered to'])assert.ok(source.includes(advanced),`advanced filter capability missing: ${advanced}`);
        assert.ok(source.includes('data-bulk-bar hidden'),'bulk actions must stay contextual until a selection exists');
        assert.ok(source.includes('Select all ${total} matching'),'bulk select-all matching semantics must be preserved');
        assert.ok(bulk.includes('bar.hidden=selected===0&&!matching'),'client must reveal bulk controls only for an active selection');
        assert.ok(source.includes("{...state,page:page+1}")&&source.includes("{...state,page:page-1}"),'pagination must preserve sort state');
        assert.ok(source.includes('aria-sort='),'sortable headings must remain accessible');
    }

    console.log('Customer filters smoke test passed.');
}
main();
