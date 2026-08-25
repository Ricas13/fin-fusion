'use strict';

const registry=require('./admin-dashboard-registry');
const widgets=require('./admin-dashboard-widgets');
const expenses=require('./business-expenses');
const reportingCurrency=require('./reporting-currency');
const {money}=require('./admin-dashboard-format');

const cache=new WeakMap();
async function expenseSummary(ctx){
  if(cache.has(ctx))return cache.get(ctx);
  const rows=await expenses.list({includeInactive:false}),target=ctx.reporting.currency,convert=(minor,from,to)=>reportingCurrency.convertMinor(minor,from,to,ctx.reporting),summary=expenses.summarize(rows,ctx.range.start,ctx.range.end,convert,target);
  cache.set(ctx,summary);return summary;
}

registry.register('commerce','operatingExpenses',{title:'Operating expenses',subtitle:'Your recorded business costs in this reporting period, converted to the portal currency.',defaultOrder:4,defaultSpan:3,render:async ctx=>{const summary=await expenseSummary(ctx);return widgets.kpiCard({key:'operatingExpenses',label:'Expenses',value:money(summary.totalMinor,ctx.reporting.currency),meta:`${summary.count} booked occurrence(s)`,href:'/admin/expenses'});}});
registry.register('commerce','netProfit',{title:'Net profit',subtitle:'Net payment revenue after refunds minus your recorded business operating expenses. Before tax.',defaultOrder:5,defaultSpan:3,render:async ctx=>{const summary=await expenseSummary(ctx),profit=Number(ctx.data.revenue.netMinor||0)-summary.totalMinor,margin=ctx.data.revenue.netMinor>0?(profit/ctx.data.revenue.netMinor)*100:null;return widgets.kpiCard({key:'netProfit',label:'Net profit',value:money(profit,ctx.reporting.currency),meta:margin==null?'No net revenue in this period':`${margin.toFixed(1)}% margin`,href:'/admin/expenses'});}});

module.exports={expenseSummary};
