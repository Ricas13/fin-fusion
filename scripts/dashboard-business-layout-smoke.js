'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const dashboard=read('src/platform/admin-dashboard.js');
const view=read('src/platform/admin-dashboard-view-v2.js');
const legacyView=read('src/platform/admin-dashboard-view.js');
const viewUtils=read('src/platform/admin-dashboard-view-utils.js');
const main=read('src/platform/admin-dashboard-main.js');
const money=read('src/platform/admin-dashboard-money.js');
const reporting=read('src/platform/reporting-currency.js');

// /admin itself now renders through the widget registry, not the legacy
// admin-dashboard-view-v2 renderer -- that renderer is retained only as
// main's own compatibility facade (still exercised by its own tests) and is
// not wired into any live route from this branch.
assert(dashboard.includes("require('./admin-dashboard-main')"),'Dashboard must use the widget-registry-based renderer');
assert(!dashboard.includes("require('./admin-dashboard-view-v2')"),'Dashboard must not depend on the legacy compatibility renderer');
assert(view.includes("require('./admin-dashboard-view-utils')"),'Legacy compatibility renderer must use the dedicated view utility module');
assert(!view.includes("require('./admin-dashboard-view')"),'Legacy compatibility renderer must not depend on the superseded renderer facade');
assert(legacyView.includes("require('./admin-dashboard-view-v2')")&&legacyView.includes("require('./admin-dashboard-view-utils')"),'Legacy dashboard view path must remain a thin compatibility facade only');
assert(!legacyView.includes('function revenueCard')&&!legacyView.includes('function renderDashboard'),'Legacy dashboard view must not retain a second dashboard renderer implementation');
assert(viewUtils.includes('function barChart')&&viewUtils.includes('function areaChart')&&viewUtils.includes('function rangeControls'),'Dashboard chart and range primitives must have one dedicated owner');
assert(!dashboard.includes('weeks:12'),'Dashboard must not hard-code the old 12-week prospective-income forecast');
assert(!dashboard.includes('admin-revenue-forecast'),'Dashboard must not depend on the prospective-income forecast path');
assert(main.includes("title: 'Revenue trend'"),'Dashboard must keep a revenue trend widget');
assert(main.includes("title: 'Customer base over time'"),'Dashboard must keep a customer growth widget');
assert(!main.includes('prospectiveIncome'),'Prospective income must be removed from the active dashboard renderer');
assert(main.includes("title: 'Revenue future'"),'Revenue Future must remain on the dashboard as the renewals-forecast widget');
assert(main.includes('ctx.data.forecastDays'),'Revenue Future must describe the selected range-derived forecast horizon');
assert(money.includes('Date.now()+range.days*86400000'),'Revenue Future data must use the dashboard range rather than a fixed 12-week horizon');
assert(money.includes('reportingCurrency.convertMinor'),'Dashboard money must be normalized for presentation');
assert(reporting.includes('async function getForUser(_userId)')&&reporting.includes('masterCurrency:true'),'Dashboard reporting currency must resolve to the platform master currency');
assert(reporting.includes('Currency is controlled platform-wide in Settings → Portal currency')&&!reporting.includes('UPDATE app_users SET preferred_currency'),'Per-user reporting currency preference must remain retired');

console.log('dashboard business layout smoke: ok');
