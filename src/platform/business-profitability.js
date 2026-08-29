'use strict';

const { query } = require('../db');
const expenses = require('./business-expenses');
const reportingCurrency = require('./reporting-currency');
const { revenueFromEvent } = require('./admin-dashboard-analytics');
const dashboardLedger = require('../payments/dashboard-ledger');

const PROFIT_BASIS = 'Net provider receipts (imported history + webhooks) minus booked expenses. Bank payouts are transfers, not costs.';

// Compatibility helpers retained for older internal callers/tests. Operator-facing
// profitability no longer reads these webhook-only rows; it uses dashboardLedger.
async function paymentRows(start,end){
  const result=await query(`SELECT provider,event_type,payload,created_at FROM payment_events WHERE provider IN('stripe','paypal') AND processed_at IS NOT NULL AND processing_error IS NULL AND created_at >= $1 AND created_at < $2 ORDER BY created_at`,[start,end]);
  return result.rows;
}
function revenueSummaryFromRows(rows,start,end,reporting){
  let grossMinor=0,refundMinor=0;const target=reporting.currency,from=new Date(start),to=new Date(end);
  for(const row of rows||[]){
    const at=new Date(row.created_at);if(at<from||at>=to)continue;
    const payment=revenueFromEvent(row);if(payment)grossMinor+=reportingCurrency.convertMinor(Number(payment.minor||0),payment.currency||target,target,reporting);
    const refund=dashboardLedger.refundFromEvent(row);if(refund)refundMinor+=reportingCurrency.convertMinor(Number(refund.minor||0),refund.currency||target,target,reporting);
  }
  return{grossMinor,refundMinor,netMinor:grossMinor-refundMinor};
}

function ledgerRange(start,end,{previousStart=start,previousEnd=start,bucket='day'}={}){
  return{start:new Date(start),end:new Date(end),previousStart:new Date(previousStart),previousEnd:new Date(previousEnd),bucket};
}
function hasHistoryCoverage(coverage,start,end){
  const from=new Date(start),to=new Date(end);
  return Object.values(coverage||{}).some(intervals=>(intervals||[]).some(interval=>new Date(interval.start)<to&&new Date(interval.end)>from));
}
function basisFor(coverage,start,end){
  const webhookOnly=!hasHistoryCoverage(coverage,start,end);
  return{webhookOnly,basisText:`${PROFIT_BASIS}${webhookOnly?' webhook-only for this range.':''}`};
}
function revenueFromLedger(ledger,start,end,{includePrevious=false}={}){
  const grossMinor=Number(ledger?.grossMinor||0)+(includePrevious?Number(ledger?.previousGrossMinor||0):0);
  const refundMinor=Number(ledger?.refundMinor||0)+(includePrevious?Number(ledger?.previousRefundMinor||0):0);
  return{grossMinor,refundMinor,netMinor:grossMinor-refundMinor,coverage:ledger?.coverage||{},warnings:ledger?.warnings||[],...basisFor(ledger?.coverage,start,end)};
}
async function revenueSummary(start,end,reporting){
  const ledger=await dashboardLedger.commerceRevenue(ledgerRange(start,end),reporting,reportingCurrency);
  return revenueFromLedger(ledger,start,end);
}
function summarizeWindow(start,end,reporting,revenue,expenseRows){
  const convert=(minor,from,to)=>reportingCurrency.convertMinor(minor,from,to,reporting),booked=expenses.summarize(expenseRows,start,end,convert,reporting.currency);
  return{start,end,revenue,expenses:booked,profitMinor:revenue.netMinor-booked.totalMinor,basisText:revenue.basisText,webhookOnly:revenue.webhookOnly};
}
async function profitSummary(start,end,reporting){
  const [revenue,expenseRows]=await Promise.all([revenueSummary(start,end,reporting),expenses.list()]);
  return summarizeWindow(start,end,reporting,revenue,expenseRows);
}

function utcDayAfter(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1));}
function monthStart(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));}
function yearStart(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),0,1));}
function mondayStart(value){const d=new Date(value),day=d.getUTCDay(),offset=(day+6)%7;return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-offset));}
function addDays(value,days){return new Date(new Date(value).getTime()+Number(days)*86400000);}

async function headerProfitability(reporting,{now=new Date()}={}){
  const currentStart=monthStart(now),end=utcDayAfter(now),ytdStart=yearStart(now);
  const [ledger,expenseRows]=await Promise.all([
    dashboardLedger.commerceRevenue(ledgerRange(currentStart,end,{previousStart:ytdStart,previousEnd:currentStart,bucket:'month'}),reporting,reportingCurrency),
    expenses.list()
  ]);
  const currentRevenue=revenueFromLedger(ledger,currentStart,end),ytdRevenue=revenueFromLedger(ledger,ytdStart,end,{includePrevious:true});
  return{currency:reporting.currency,current:summarizeWindow(currentStart,end,reporting,currentRevenue,expenseRows),ytd:summarizeWindow(ytdStart,end,reporting,ytdRevenue,expenseRows)};
}
async function dashboardProfitability(reporting,{now=new Date(),weeks=8}={}){
  const currentStart=monthStart(now),currentEnd=utcDayAfter(now),previousStart=monthStart(addDays(currentStart,-1)),ytdStart=yearStart(now);
  const weekCount=Math.max(1,Math.min(26,Number(weeks)||8)),thisWeek=mondayStart(now),firstWeek=addDays(thisWeek,-7*(weekCount-1));
  const windows=[];for(let i=0;i<weekCount;i+=1){const start=addDays(firstWeek,i*7),end=i===weekCount-1?currentEnd:addDays(start,7);windows.push({start,end,label:start.toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'})});}
  const ledgerPromises=[
    dashboardLedger.commerceRevenue(ledgerRange(currentStart,currentEnd,{previousStart:ytdStart,previousEnd:currentStart,bucket:'month'}),reporting,reportingCurrency),
    dashboardLedger.commerceRevenue(ledgerRange(previousStart,currentStart),reporting,reportingCurrency),
    ...windows.map(window=>dashboardLedger.commerceRevenue(ledgerRange(window.start,window.end,{bucket:'week'}),reporting,reportingCurrency))
  ];
  const [expenseRows,baseLedger,previousLedger,...weekLedgers]=await Promise.all([expenses.list(),...ledgerPromises]);
  const currentRevenue=revenueFromLedger(baseLedger,currentStart,currentEnd),ytdRevenue=revenueFromLedger(baseLedger,ytdStart,currentEnd,{includePrevious:true}),previousRevenue=revenueFromLedger(previousLedger,previousStart,currentStart);
  const weekly=windows.map((window,index)=>{const revenue=revenueFromLedger(weekLedgers[index],window.start,window.end),row=summarizeWindow(window.start,window.end,reporting,revenue,expenseRows);return{label:window.label,receipts:row.revenue.netMinor,expenses:row.expenses.totalMinor,profit:row.profitMinor,basisText:row.basisText,webhookOnly:row.webhookOnly};});
  const weeklyBasis=basisFor(baseLedger.coverage,firstWeek,currentEnd);
  return{
    currency:reporting.currency,
    current:summarizeWindow(currentStart,currentEnd,reporting,currentRevenue,expenseRows),
    previous:summarizeWindow(previousStart,currentStart,reporting,previousRevenue,expenseRows),
    ytd:summarizeWindow(ytdStart,currentEnd,reporting,ytdRevenue,expenseRows),
    weekly,
    basisText:weeklyBasis.basisText,
    webhookOnly:weeklyBasis.webhookOnly
  };
}

module.exports={PROFIT_BASIS,paymentRows,revenueSummaryFromRows,revenueSummary,profitSummary,headerProfitability,dashboardProfitability,monthStart,yearStart,utcDayAfter,mondayStart,hasHistoryCoverage,basisFor};
