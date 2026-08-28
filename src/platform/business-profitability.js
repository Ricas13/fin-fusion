'use strict';

const { query } = require('../db');
const expenses = require('./business-expenses');
const reportingCurrency = require('./reporting-currency');
const { revenueFromEvent } = require('./admin-dashboard-analytics');
const dashboardLedger = require('../payments/dashboard-ledger');

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
async function revenueSummary(start,end,reporting){return revenueSummaryFromRows(await paymentRows(start,end),start,end,reporting);}
function summarizeWindow(start,end,reporting,payments,expenseRows){
  const convert=(minor,from,to)=>reportingCurrency.convertMinor(minor,from,to,reporting),revenue=revenueSummaryFromRows(payments,start,end,reporting),booked=expenses.summarize(expenseRows,start,end,convert,reporting.currency);
  return{start,end,revenue,expenses:booked,profitMinor:revenue.netMinor-booked.totalMinor};
}
async function profitSummary(start,end,reporting){const [payments,expenseRows]=await Promise.all([paymentRows(start,end),expenses.list()]);return summarizeWindow(start,end,reporting,payments,expenseRows);}

function utcDayAfter(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1));}
function monthStart(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));}
function yearStart(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),0,1));}
function mondayStart(value){const d=new Date(value),day=d.getUTCDay(),offset=(day+6)%7;return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-offset));}
function addDays(value,days){return new Date(new Date(value).getTime()+Number(days)*86400000);}

async function headerProfitability(reporting,{now=new Date()}={}){
  const currentStart=monthStart(now),end=utcDayAfter(now),ytdStart=yearStart(now),ledgerStart=ytdStart<currentStart?ytdStart:currentStart;
  const [payments,expenseRows]=await Promise.all([paymentRows(ledgerStart,end),expenses.list()]);
  return{currency:reporting.currency,current:summarizeWindow(currentStart,end,reporting,payments,expenseRows),ytd:summarizeWindow(ytdStart,end,reporting,payments,expenseRows)};
}
async function dashboardProfitability(reporting,{now=new Date(),weeks=8}={}){
  const currentStart=monthStart(now),currentEnd=utcDayAfter(now),previousStart=monthStart(addDays(currentStart,-1)),ytdStart=yearStart(now);
  const weekCount=Math.max(1,Math.min(26,Number(weeks)||8)),thisWeek=mondayStart(now),firstWeek=addDays(thisWeek,-7*(weekCount-1));
  const ledgerStart=new Date(Math.min(previousStart.getTime(),ytdStart.getTime(),firstWeek.getTime()));
  const [payments,expenseRows]=await Promise.all([paymentRows(ledgerStart,currentEnd),expenses.list()]);
  const windows=[];for(let i=0;i<weekCount;i+=1){const start=addDays(firstWeek,i*7),end=i===weekCount-1?currentEnd:addDays(start,7);windows.push({start,end,label:start.toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'})});}
  return{
    currency:reporting.currency,
    current:summarizeWindow(currentStart,currentEnd,reporting,payments,expenseRows),
    previous:summarizeWindow(previousStart,currentStart,reporting,payments,expenseRows),
    ytd:summarizeWindow(ytdStart,currentEnd,reporting,payments,expenseRows),
    weekly:windows.map(window=>{const row=summarizeWindow(window.start,window.end,reporting,payments,expenseRows);return{label:window.label,receipts:row.revenue.netMinor,expenses:row.expenses.totalMinor,profit:row.profitMinor};})
  };
}

module.exports={paymentRows,revenueSummaryFromRows,revenueSummary,profitSummary,headerProfitability,dashboardProfitability,monthStart,yearStart,utcDayAfter,mondayStart};
