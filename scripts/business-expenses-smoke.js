'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const expenses=require('../src/platform/business-expenses');
const adminExpenses=require('../src/platform/admin-expenses');
const root=path.join(__dirname,'..');
const read=file=>fs.readFileSync(path.join(root,file),'utf8');

function row(overrides={}){return{start_date:'2024-01-31',end_date:null,recurrence:'monthly',active:true,amount_minor:1000,currency:'GBP',category:'Hosting',supplier:'Example',name:'Example expense',...overrides};}
function dates(r,start,end){return expenses.occurrences(r,start,end).map(d=>d.toISOString().slice(0,10));}

assert.deepStrictEqual(dates(row(),'2024-01-01','2024-05-01'),['2024-01-31','2024-02-29','2024-03-31','2024-04-30'],'monthly expenses must preserve the intended day and clamp to month end');
assert.deepStrictEqual(dates(row({recurrence:'quarterly',start_date:'2024-02-29'}),'2024-01-01','2025-03-01'),['2024-02-29','2024-05-29','2024-08-29','2024-11-29','2025-02-28'],'quarterly expenses must recur predictably across leap years');
assert.deepStrictEqual(dates(row({recurrence:'yearly',start_date:'2024-02-29'}),'2024-01-01','2027-01-01'),['2024-02-29','2025-02-28','2026-02-28'],'yearly leap-day expenses must clamp safely');
assert.deepStrictEqual(dates(row({recurrence:'one_time',start_date:'2024-06-15'}),'2024-01-01','2025-01-01'),['2024-06-15'],'one-off expenses must be booked exactly once');
assert.deepStrictEqual(dates(row({end_date:'2024-03-31'}),'2024-01-01','2025-01-01'),['2024-01-31','2024-02-29','2024-03-31'],'recurring expenses must stop at their optional end date');

const summary=expenses.summarize([row(),row({start_date:'2024-02-15',recurrence:'one_time',amount_minor:2500,category:'Hardware',supplier:'Shop'})],'2024-01-01','2024-04-01',(minor)=>minor,'GBP');
assert.equal(summary.totalMinor,5500,'summary must include three monthly occurrences plus one one-off cost');
assert.equal(summary.count,4,'summary must count booked expense occurrences');
assert.deepStrictEqual(summary.byCategory.map(x=>[x.name,x.amountMinor]),[['Hosting',3000],['Hardware',2500]],'category breakdown must be value ordered');

const sortableRows=[
  row({name:'Cheap',amount_minor:699,supplier:'Zulu',start_date:'2026-02-01',active:true}),
  row({name:'Expensive',amount_minor:45000,supplier:'Alpha',start_date:'2026-01-01',active:false}),
  row({name:'Middle',amount_minor:1100,supplier:'Bravo',start_date:'2026-03-01',active:true})
];
assert.deepStrictEqual(adminExpenses.filteredLedger(sortableRows,adminExpenses.ledgerState({sort:'amount',dir:'desc'})).map(x=>x.name),['Expensive','Middle','Cheap'],'expense ledger must support descending numeric column sorting');
assert.deepStrictEqual(adminExpenses.filteredLedger(sortableRows,adminExpenses.ledgerState({sort:'supplier',dir:'asc'})).map(x=>x.name),['Expensive','Middle','Cheap'],'expense ledger must support ascending text column sorting');
assert.deepStrictEqual(adminExpenses.filteredLedger(sortableRows,adminExpenses.ledgerState({sort:'status',dir:'asc'})).map(x=>x.name),['Expensive','Cheap','Middle'],'expense ledger status sorting must remain deterministic');

const migration=read('db/migrations/041_business_expenses.sql');
const admin=read('src/platform/admin-expenses.js');
const nav=read('src/platform/admin-nav.js');
const routes=read('src/platform/admin-route-composition.js');
const widgets=read('src/platform/admin-commerce-expense-widgets.js');
const profit=read('src/platform/business-profitability.js');
for(const term of ['business_expenses','one_time','monthly','quarterly','yearly','amount_minor','currency'])assert(migration.includes(term),`expense migration is missing ${term}`);
for(const term of ['/admin/expenses','Add business expense','Annual profitability','Projected annual expenses','Export CSV'])assert(admin.includes(term),`expense admin workspace is missing ${term}`);
assert(admin.includes('Gross provider receipts')&&admin.includes('Net provider receipts')&&admin.includes('d.revenue.basisText'),'Expenses annual profitability must use and explain canonical provider receipts');
assert(admin.includes('expenseSortLink')&&admin.includes('aria-sort=')&&admin.includes("['name','supplier','category','recurrence','amount','start','end','status']"),'Expense ledger column headings must own bidirectional sorting for every meaningful visible column');
assert(admin.includes('height:32px')&&admin.includes('padding:5px 7px!important'),'Desktop expense rows must stay deliberately dense instead of expanding into card-like rows');
assert(admin.includes('<details class="section expenseAddDisclosure"')&&admin.includes("addOpen=String(req.query.add||'')==='1'"),'Add expense must be collapsed by default and open deliberately from the page action');
assert(!admin.includes('<label>Sort by</label>'),'Column headings must replace the redundant Sort by filter control');
assert(profit.includes('dashboardLedger.commerceRevenue')&&profit.includes('revenue.netMinor-booked.totalMinor'),'shared profitability must read the Commerce ledger and subtract only booked business expenses');
assert(nav.includes("expenses:Object.freeze")&&nav.includes("['expenses','Expenses & Profitability','/admin/expenses']"),'Expenses must be a Payments & Billing child workflow');
assert(routes.includes('createAdminExpensesRouter')&&routes.includes("require('./admin-commerce-expense-widgets')"),'expense routes and profitability widgets must be mounted');
assert(widgets.includes("registry.register('commerce','operatingExpenses'")&&widgets.includes("registry.register('commerce','netProfit'"),'Commerce must show operating expenses and net profit');
assert(widgets.includes('ctx.data.revenue.netMinor')&&widgets.includes('summary.totalMinor'),'Net profit must subtract recorded expenses from net revenue');

console.log('business expenses and profitability smoke: ok');