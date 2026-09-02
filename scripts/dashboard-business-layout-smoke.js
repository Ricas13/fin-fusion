'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const dashboard=read('src/platform/admin-dashboard.js');
const view=read('src/platform/admin-dashboard-view.js');
const viewUtils=read('src/platform/admin-dashboard-view-utils.js');
const main=read('src/platform/admin-dashboard-main.js');
const reporting=read('src/platform/reporting-currency.js');
const profit=read('src/platform/business-profitability.js');
const dashboardCss=read('public/css/admin-profit-dashboard.css');

assert(dashboard.includes("require('./admin-dashboard-main')"),'Dashboard must use the widget-registry-based renderer');
assert(!dashboard.includes("require('./admin-dashboard-view-v2')"),'Dashboard must not depend on the retired dashboard renderer path');
assert(view.includes("require('./admin-dashboard-view-utils')"),'Canonical dashboard renderer must use the dedicated view utility module');
assert(view.includes('function renderDashboard'),'Canonical dashboard view must own the reusable renderer implementation');
assert(viewUtils.includes('function barChart')&&viewUtils.includes('function areaChart')&&viewUtils.includes('function rangeControls'),'Dashboard chart and range primitives must retain one dedicated owner');
assert(main.includes("title:'Weekly receipts vs expenses'"),'Dashboard must have one money chart for weekly net receipts versus expenses');
assert(main.includes("title:'New vs cancelled'"),'Dashboard must keep the canonical new-vs-cancelled growth chart');
assert(main.includes("title:'Service mix'"),'Dashboard must reduce mix to Jellyfin/Stremio/free');
assert(!main.includes("title: 'Monthly recurring revenue'")&&!main.includes("title: 'Revenue trend'")&&!main.includes("title: 'Revenue mix'")&&!main.includes("title: 'Primary plan distribution'"),'MRR/revenue/plan duplicates must not remain registered on /admin');
assert(dashboard.includes('Profit this month')&&dashboard.includes('Profit YTD'),'Dashboard hero must lead with profit');
assert(dashboard.includes('used / sellable stream capacity')&&dashboard.includes('Needs attention'),'Dashboard hero must include streams capacity and attention');
assert(dashboard.includes('adminDashboardCompactBody')&&dashboard.includes('profitMetricPair'),'Task B must keep /admin inside the compact body contract and pair month/YTD profit without dropping either metric');
for(const widget of ['cashFlow','newVsCancelled','serviceMix'])assert(main.includes(`registry.register('main','${widget}'`)&&main.match(new RegExp(`registry\\.register\\('main','${widget}'[\\s\\S]*?defaultSpan:4`)),`Main dashboard widget ${widget} must default to one third of the 12-column body grid`);
assert(dashboardCss.includes('.profitHeroGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'),'Dashboard summary must default to the compact three-column body rhythm');
assert(dashboardCss.includes('.adminDashboardCompactBody .chartSvg{min-height:158px;max-height:178px}'),'Dashboard charts must stay compact rather than returning to oversized body cards');
assert(dashboardCss.includes('.adminDashboardCompactBody .analyticsGrid{gap:10px;align-items:start}')&&dashboardCss.includes('.adminDashboardCompactBody .analyticsCard.widgetCard{height:auto;min-height:0;align-self:start}'),'Compact dashboard widgets must size to their own content instead of stretching to the tallest card');
assert(dashboardCss.includes('@media(max-width:820px)')&&dashboardCss.includes('.profitHeroGrid{grid-template-columns:1fr}'),'Compact dashboard body must collapse safely on mobile');
assert(profit.includes('revenue.netMinor-booked.totalMinor'),'Profit must remain net provider receipts minus booked expenses');
assert(profit.includes("provider IN('stripe','paypal')"),'Profit must stay aligned with the current Expenses provider scope');
assert(reporting.includes('async function getForUser(_userId)')&&reporting.includes('masterCurrency:true'),'Dashboard reporting currency must resolve to the platform master currency');
assert(reporting.includes('Currency is controlled platform-wide in Settings → Portal currency')&&!reporting.includes('UPDATE app_users SET preferred_currency'),'Per-user reporting currency preference must remain retired');

console.log('dashboard business layout smoke: ok');
