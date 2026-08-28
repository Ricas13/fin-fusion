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
assert(profit.includes('revenue.netMinor-booked.totalMinor'),'Profit must remain net provider receipts minus booked expenses');
assert(profit.includes("provider IN('stripe','paypal')"),'Profit must stay aligned with the current Expenses provider scope');
assert(reporting.includes('async function getForUser(_userId)')&&reporting.includes('masterCurrency:true'),'Dashboard reporting currency must resolve to the platform master currency');
assert(reporting.includes('Currency is controlled platform-wide in Settings → Portal currency')&&!reporting.includes('UPDATE app_users SET preferred_currency'),'Per-user reporting currency preference must remain retired');

console.log('dashboard business layout smoke: ok');
