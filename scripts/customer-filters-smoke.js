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
        assert.ok(built.whereSql.includes('effective_customer_entitlements live'),'lapsed audiences must use effective-entitlement authority');
        assert.ok(built.whereSql.includes("COALESCE(cur.access_expires_at,cur.current_period_end)<=NOW()+($4::int*INTERVAL '1 day')"),'expiry targeting must respect effective extension/permanent semantics');
        assert.ok(built.whereSql.includes('FROM playback_history ph_segment'),'playback inactivity must use canonical playback history');
        assert.deepStrictEqual(built.params,['year',30,14,7,60]);
    }

    // Access means media-service access. Portal sign-in and historical sync
    // failures must not make a provisioned customer look as though access is missing.
    {
        const active=buildWhere({access:'active'},null);
        const needsAccess=buildWhere({access:'needs_access'},null);
        const attention=buildWhere({access:'attention'},null);
        const provisioning=buildWhere({access:'provisioning'},null);
        const expired=buildWhere({access:'expired'},null);
        assert.ok(active.whereSql.includes('cur.is_current'),'ready filter must use effective current entitlement truth');
        assert.ok(active.whereSql.includes('customer_account_count'),'current Jellyfin/bundle access must require a present customer Jellyfin identity');
        assert.ok(!active.whereSql.includes('au.active'),'portal sign-in must not decide media access readiness');
        assert.ok(needsAccess.whereSql.includes("NOT IN ('pending','running')")&&needsAccess.whereSql.includes('customer_account_count'),'needs-access must mean current entitlement with missing Jellyfin access');
        assert.ok(provisioning.whereSql.includes("provision.status IN ('pending','running')"),'provisioning must only describe an in-progress missing-access state');
        assert.ok(attention.whereSql.includes("cur.status='past_due'")&&attention.whereSql.includes('recon.rank'),'attention may still surface billing and policy-sync issues');
        assert.ok(expired.whereSql.includes('cur.is_current')&&expired.whereSql.includes('cur.id IS NOT NULL'),'expired must mean plan history exists but no effective entitlement is current');
        const legacy=buildWhere({accountStatus:'disabled'},null);
        assert.ok(!legacy.whereSql.includes('has_enabled_account'),'retired Jellyfin disabled filtering must not return as a valid lifecycle state');
    }

    {
        const moduleSource=fs.readFileSync(path.join(__dirname,'../src/platform/customer-filters.js'),'utf8');
        assert.ok(moduleSource.includes('effective_customer_entitlements e'),'customer list must select the same effective entitlement authority as provisioning');
        assert.ok(moduleSource.includes("ja.account_purpose='jellyfin'"),'Jellyfin readiness must ignore internal Stremio delivery accounts');
        assert.ok(moduleSource.includes('COALESCE(cur.is_current,FALSE) AS has_current_entitlement'),'rows must expose whether displayed plan history is actually current');
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

    // Customers is a single compact operator workspace: dashboard overview,
    // one primary filter toolbar, one secondary disclosure and an actionable table.
    {
        const source=fs.readFileSync(path.join(__dirname,'../src/platform/admin-customers-list.js'),'utf8');
        const filterClient=fs.readFileSync(path.join(__dirname,'../public/js/admin-customer-filters.js'),'utf8');
        const mobileCss=fs.readFileSync(path.join(__dirname,'../public/css/admin-customers-list.css'),'utf8');
        const bulk=fs.readFileSync(path.join(__dirname,'../public/js/admin-customers-bulk.js'),'utf8');

        assert.ok(source.includes('customerKpiGrid')&&source.includes('customerInsightGrid'),'customer overview must use the compact KPI + insight layout');
        for(const label of ['Total customers','Active access','Recently active','Needs attention','Customer health','Plan mix','Access & support'])assert.ok(source.includes(label),`overview card missing: ${label}`);

        assert.ok(source.includes('customerPrimaryFilters'),'primary customer controls must share one visible toolbar');
        assert.ok(source.includes('placeholder="Name, email or Jellyfin username"'),'customer search must match the approved Name-first filter while retaining useful identity search');
        assert.ok(source.includes('<option value="">All products</option>'),'Product must default to All products');
        assert.ok(source.includes("const accessOptions=[['','Any']"),'Access must default to Any');
        assert.ok(source.includes('<option value="">Any Plan</option>'),'Plan must default to Any Plan');
        assert.ok(source.includes('<option value="">Any Jellyfin Server</option>'),'Server must default to Any Jellyfin Server');
        assert.ok(source.includes('More Advanced Filters'),'secondary filters must use the approved disclosure label');
        assert.ok(source.includes('<details class="customerMoreFilters"'),'there must be one secondary filter disclosure');
        const productPos=source.indexOf('id="customerFilterProduct"'),accessPos=source.indexOf('id="customerFilterAccess"'),planPos=source.indexOf('id="customerFilterPlan"'),serverPos=source.indexOf('id="customerFilterServer"');
        assert.ok(productPos<accessPos&&accessPos<planPos&&planPos<serverPos,'toolbar order must stay Product / Access / Plan / Server');
        assert.ok(!filterClient.includes('appendChild'),'client filter code must never relocate server-rendered controls');
        assert.ok(filterClient.includes('[data-primary-filter]'),'primary selects should auto-apply without another nested Apply row');

        assert.ok(source.includes("sortHeader(filters,sortState,'Plan','plan'"),'table must expose the approved Plan column');
        assert.ok(source.includes("sortHeader(filters,sortState,'Access','access'"),'table must expose the approved Access column');
        assert.ok(source.includes('<th>Jellyfin</th>'),'table must expose the approved Jellyfin column');
        assert.ok(source.includes("sortHeader(filters,sortState,'Server','server'"),'server placement must stay visible');
        assert.ok(source.includes("sortHeader(filters,sortState,'Renews / expires','expiring'"),'renewal/expiry must use the approved wording');
        assert.ok(source.includes("sortHeader(filters,sortState,'Last active','recent'"),'last activity must stay visible');
        assert.ok(source.includes('<th>Action</th>'),'table must expose the approved singular Action column');
        assert.ok(source.includes("x.plan_name||'No plan'"),'Plan cells must show the actual plan name rather than replacing it with billing type');
        assert.ok(source.includes('function planMeta(x)'),'Plan cells must retain Free/Paid/Trial and product context beneath the plan name');
        assert.ok(!source.includes("formatMinor(Number(x.price_minor||0),'USD'"),'Customers must not invent USD pricing for plans whose currency is not selected');
        assert.ok(source.includes('function serviceActivity(x)'),'Jellyfin/service cells must expose recency like the approved mockup');
        assert.ok(source.includes('Last used ${relativeTime(x.last_activity_at)}'),'service recency must be derived from recorded activity');
        assert.ok(source.includes('customerAvatar'),'rows must keep the high-scanability identity treatment');
        assert.ok(source.includes('customerRowActions'),'row actions must stay explicit');
        assert.ok(source.includes('customerAccessReason'),'attention/reason context must sit beneath the Access state');
        assert.ok(source.includes('customerPageSize'),'table must expose a rows-per-page control');
        assert.ok(source.includes("{sort:'recent',dir:'desc'}"),'Customers should default to last-active sorting like the approved mockup');
        assert.ok(!source.includes('customerViewButtons'),'do not show a decorative grid/list switch when only list view exists');
        assert.ok(!source.includes("sortHeader(filters,sortState,'Registered','registered'"),'registration date must not occupy the default table');
        assert.ok(!source.includes('Jellyfin disabled'),'the retired Jellyfin disabled state must not be exposed');

        for(const preset of ['Needs attention','Ready','Trials','Free','Paid','No plan'])assert.ok(source.includes(preset),`quick preset missing: ${preset}`);
        for(const advanced of ['Payment provider','Subscription status','Customer settings','Library','Registered from','Registered to'])assert.ok(source.includes(advanced),`secondary filter capability missing: ${advanced}`);
        assert.ok(source.includes('data-bulk-bar hidden'),'bulk actions must stay contextual until a selection exists');
        assert.ok(source.includes('Select all ${total} matching'),'bulk select-all matching semantics must be preserved');
        assert.ok(bulk.includes('bar.hidden=selected===0&&!matching'),'client must reveal bulk controls only for an active selection');
        assert.ok(source.includes('aria-sort='),'sortable headings must remain accessible');

        // The shared responsiveTable stylesheet normally turns rows into cards.
        // Customers must remain a horizontally pannable table with pinned identity/action.
        assert.ok(mobileCss.includes('.customerResults .tableWrap>.customerTable{display:table!important'),'mobile Customers must stay a real table instead of becoming cards');
        assert.ok(mobileCss.includes('overflow-x:auto!important'),'mobile Customers must allow horizontal panning when all columns do not fit');
        assert.ok(mobileCss.includes('.customerTable td::before{display:none!important;content:none!important}'),'mobile Customers must suppress card-style data-label pseudo headings');
        assert.ok(mobileCss.includes('.customerTable th:nth-child(2),.customerTable td:nth-child(2){position:sticky!important'),'customer identity must stay pinned while the operator pans the table');
        assert.ok(mobileCss.includes('.customerTable th:last-child,.customerTable td:last-child{position:sticky!important'),'row action must stay pinned on the right on mobile');
    }

    console.log('Customer filters smoke test passed.');
}
main();
