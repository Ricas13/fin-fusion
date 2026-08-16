'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const dashboard=read('src/platform/admin-dashboard.js');
const view=read('src/platform/admin-dashboard-view-v2.js');
const money=read('src/platform/admin-dashboard-money.js');
const reporting=read('src/platform/reporting-currency.js');

assert(dashboard.includes("require('./admin-dashboard-view-v2')"),'Dashboard must use the cleaned business-performance renderer');
assert(!dashboard.includes('weeks:12'),'Dashboard must not hard-code the old 12-week prospective-income forecast');
assert(!dashboard.includes('admin-revenue-forecast'),'Dashboard must not depend on the prospective-income forecast path');
assert(view.includes("<h2>Business performance</h2>"),'Dashboard must keep the Business performance section');
assert(view.includes('${revenueHistory(s)}${customerGrowth(s)}'),'Business performance must contain only revenue history and customer growth');
assert(!view.includes('prospectiveIncome'),'Prospective income must be removed from the active dashboard renderer');
assert(view.includes("card('Revenue future'"),'Revenue Future must remain in Commerce');
assert(view.includes('s.forecastDays'),'Revenue Future must describe the selected range-derived forecast horizon');
assert(money.includes('Date.now()+range.days*86400000'),'Revenue Future data must use the dashboard range rather than a fixed 12-week horizon');
assert(money.includes('reportingCurrency.convertMinor'),'Dashboard money must be normalized for presentation');
assert(reporting.includes('getForUser(userId)'),'Reporting currency must support a signed-in user preference');
assert(reporting.includes("preferred_currency"),'Per-user reporting currency must be persisted separately from raw transaction currency');

console.log('dashboard business layout smoke: ok');
