'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const classifier=require('../src/payments/provider-transaction-classifier');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const source=read('public/js/operator-business-indicators.js');
const indicatorStyles=read('public/css/operator-business-indicators.css');
const state=read('src/platform/admin-operator-state.js');
const profit=read('src/platform/business-profitability.js');
const expensePage=read('src/platform/admin-expenses.js');
const ledger=read('src/payments/dashboard-ledger.js');

assert(source.includes('function relocatePageActions()'), 'admin header must keep relocating page actions into the CURRENT/RELATED row');
assert(source.includes(".topStatusWrap,.topHelpLink,[data-operator-header-metrics]"), 'status, help and shared metrics must stay in the global header');
assert(source.includes('data-operator-signal="new"')&&source.includes("signalMenuMarkup({key:'alerts',tone:'alert'")&&source.includes("signalMenuMarkup({key:'inbox',tone:'inbox'"),'operator header must expose separate New, Alerts and Inbox signals');
assert(source.includes("primaryHref:'/admin/attention'")&&source.includes("href:'/admin/payments'")&&source.includes("href:'/admin/commerce/orders'")&&source.includes("href:'/admin/tickets'"),'alert and inbox menus must lead to their canonical operator queues');
assert(source.includes("tone:'alert'")&&source.includes("tone:'inbox'")&&source.includes('operatorSignal--new'),'header signals must retain distinct semantic tones');
assert(!source.includes("count.textContent=total>0?(total>99?'99+':String(total)):'Clear'"),'split header signals must not render Clear into every zero state');
assert(source.includes("headLabel:'Operational alerts'")&&source.includes('Health persists · provider callbacks clear after review'),'Alerts must distinguish persistent operational health from reviewable provider callback notifications');
assert(source.includes("meta:'Unacknowledged items — acknowledge after review'")&&source.includes("meta:'Unresolved health state — clears when recovered'")&&source.includes("meta:'New provider callback issues — clears after review'"),'each Alerts source must explain its own clearing semantics');
assert(source.includes("badge.textContent=key==='alerts'?'!'"),'Alerts summary must be a state indicator rather than a misleading sum of overlapping signal counts');
assert(source.includes('attention and server health persist until resolved; payment callback notifications clear after review.'),'Alerts accessibility copy must describe the mixed persistent/reviewable semantics explicitly');
assert(!indicatorStyles.includes('operatorAlertPulse')&&indicatorStyles.includes('.operatorSignal--alert .operatorSignalSummary::before'),'Alerts must use a static state treatment rather than a perpetual unread-style pulse');
assert(source.includes('<span>Profit</span>')&&source.includes('data-operator-profit'),'admin header must show profit instead of gross revenue');
assert(source.includes('href="/admin/expenses"'),'profit header metric must link to Expenses & Profitability');
assert(source.includes('monthlyProfit')&&source.includes('yearlyProfit'),'profit chip must render both month and calendar-year/YTD profit');
assert(source.includes('Net provider receipts (imported history + webhooks) minus booked expenses. Bank payouts are transfers, not costs.'),'profit tooltip must state the canonical operator profit definition');
assert(source.includes('basisText')&&source.includes('Month:')&&source.includes('YTD:'),'profit tooltip must reflect month/YTD ledger coverage returned by the server');
assert(!source.includes('<span>Monthly revenue</span>')&&!source.includes('data-operator-revenue'),'gross monthly revenue must not remain as the visible header money chip');
assert(source.includes('`${active}/${total}`'), 'stream metric must render live streams over total configured stream capacity');
assert(source.includes("'—/—'"), 'stream metric fallback must retain the compact live/total shape');
assert(state.includes("require('./business-profitability')")&&state.includes('profitability.headerProfitability'),'header metrics must use the shared profitability owner');
assert(state.includes('basisText:profit.current.basisText')&&state.includes('basisText:profit.ytd.basisText'),'header metric payload must carry truthful coverage copy');
assert(state.includes('streams:{active:activeStreams,total:totalStreams}'),'Streams metric contract must remain unchanged');
assert(profit.includes("require('../payments/dashboard-ledger')")&&profit.includes('dashboardLedger.commerceRevenue'),'operator profitability must use the same imported-history plus uncovered-webhook ledger as Commerce Analytics');
assert(profit.includes('revenue.netMinor-booked.totalMinor'),'profit must be net provider receipts minus booked expenses');
assert(profit.includes('webhook-only for this range'),'profitability must disclose ranges with no imported history coverage');
assert(expensePage.includes("require('./business-profitability')")&&expensePage.includes('return profitability.revenueSummary(start,end,reporting)'),'Expenses, header and dashboard must execute the shared profitability owner');
assert(expensePage.includes('d.revenue.basisText')&&expensePage.includes('Gross provider receipts')&&expensePage.includes('Net provider receipts'),'Expenses annual profitability must explain and label the canonical receipts basis');
assert(ledger.includes('const kind = classifier.historyKind(row);')&&ledger.includes('if (kind) records.push(historyRecord(row, kind));'),'history rows must enter accounting only through the canonical provider transaction classifier');
assert.equal(classifier.historyKind({provider:'stripe',transaction_type:'payout',transaction_status:'paid',gross_amount_minor:999999}),null,'Stripe payout rows must never become gross revenue');
assert.equal(classifier.historyKind({provider:'stripe',transaction_type:'fee',transaction_status:'paid',gross_amount_minor:999999}),null,'Stripe fee rows must never become gross revenue');
assert.equal(classifier.historyKind({provider:'paypal',transaction_type:'T0400',transaction_status:'S',gross_amount_minor:999999}),null,'non-allowlisted PayPal movement rows must never become gross revenue');

console.log('admin header business metrics smoke: ok');
