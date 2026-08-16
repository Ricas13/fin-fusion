'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const dashboard=read('src/platform/admin-dashboard.js');
const view=read('src/platform/admin-dashboard-view.js');
const forecast=read('src/platform/admin-revenue-forecast.js');
const css=read('public/css/admin-dashboard-forecast-compact.css');

assert(dashboard.includes('forecast.renderCompact(prospect,csrf.token(req))'),'Dashboard must render the compact prospective-income card');
assert(!dashboard.includes('${forecast.render(prospect,csrf.token(req))}'),'Dashboard must not render the old full-width forecast ahead of the analytics view');
assert(view.includes("function renderDashboard(s,{prospectiveIncome=''}={})"),'Dashboard view must accept the prospective-income card as composed content');
assert(view.includes("className: 'third', stat: { value: money(s.revenue.totalMinor, currency)"),'Revenue history must occupy one third of the primary business row');
assert(view.includes("'Customer base over time', 'Cumulative CAPTaINFiN customer accounts', areaChart(s.customerGrowth, 'total'), { className: 'third'"),'Customer growth must occupy one third of the primary business row');
assert(view.includes('${prospectiveIncome}'),'Prospective income must be inserted into the Business performance grid');
assert(forecast.includes('analyticsCard third forecastCard forecastCompact'),'Compact prospective income must use the same one-third analytics card contract');
assert(css.includes('.forecastCompact .forecastChart svg'),'Compact forecast CSS must remove the old wide-chart constraint');
assert(css.includes('min-width:0!important'),'Compact forecast chart must be allowed to shrink inside a three-column grid');

console.log('dashboard business layout smoke: ok');
