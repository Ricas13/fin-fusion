'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const source=read('public/js/operator-business-indicators.js');
const state=read('src/platform/admin-operator-state.js');
const profit=read('src/platform/business-profitability.js');
const expensePage=read('src/platform/admin-expenses.js');

assert(source.includes('function relocatePageActions()'), 'admin header must keep relocating page actions into the CURRENT/RELATED row');
assert(source.includes(".topStatusWrap,.topHelpLink,[data-operator-header-metrics]"), 'status, help and shared metrics must stay in the global header');
assert(source.includes('data-operator-signal="new"')&&source.includes("signalMenuMarkup({key:'alerts',tone:'alert'")&&source.includes("signalMenuMarkup({key:'inbox',tone:'inbox'"),'operator header must expose separate New, Alerts and Inbox signals');
assert(source.includes("primaryHref:'/admin/attention'")&&source.includes("href:'/admin/payments'")&&source.includes("href:'/admin/commerce/orders'")&&source.includes("href:'/admin/tickets'"),'alert and inbox menus must lead to their canonical operator queues');
assert(source.includes("tone:'alert'")&&source.includes("tone:'inbox'")&&source.includes('operatorSignal--new'),'header signals must retain distinct semantic tones');
assert(!source.includes("count.textContent=total>0?(total>99?'99+':String(total)):'Clear'"),'split header signals must not render Clear into every zero state');
assert(source.includes('<span>Profit</span>')&&source.includes('data-operator-profit'),'admin header must show profit instead of gross revenue');
assert(source.includes('href="/admin/expenses"'),'profit header metric must link to Expenses & Profitability');
assert(source.includes('monthlyProfit')&&source.includes('yearlyProfit'),'profit chip must render both month and calendar-year/YTD profit');
assert(source.includes('only as good as the expense ledger')&&source.includes('profit equals net revenue'),'profit tooltip must explain expense-ledger completeness');
assert(!source.includes('<span>Monthly revenue</span>')&&!source.includes('data-operator-revenue'),'gross monthly revenue must not remain as the visible header money chip');
assert(source.includes('`${active}/${total}`'), 'stream metric must render live streams over total configured stream capacity');
assert(source.includes("'—/—'"), 'stream metric fallback must retain the compact live/total shape');
assert(state.includes("require('./business-profitability')")&&state.includes('profitability.headerProfitability'),'header metrics must use the shared profitability owner');
assert(state.includes('streams:{active:activeStreams,total:totalStreams}'),'Streams metric contract must remain unchanged');
assert(profit.includes("provider IN('stripe','paypal')")&&profit.includes('processed_at IS NOT NULL')&&profit.includes('processing_error IS NULL'),'profitability must use the same processed Stripe/PayPal receipt scope as /admin/expenses');
assert(profit.includes('revenue.netMinor-booked.totalMinor'),'profit must be net provider receipts minus booked expenses');
assert(expensePage.includes("require('./business-profitability')")&&expensePage.includes('return profitability.revenueSummary(start,end,reporting)'),'Expenses, header and dashboard must execute the same net-receipts accounting function');

console.log('admin header business metrics smoke: ok');
