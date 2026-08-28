'use strict';

const { query } = require('../db');
const expenses = require('./business-expenses');
const reportingCurrency = require('./reporting-currency');
const { revenueFromEvent } = require('./admin-dashboard-analytics');
const dashboardLedger = require('../payments/dashboard-ledger');

async function revenueSummary(start,end,reporting){
  const result=await query(`SELECT provider,event_type,payload,created_at FROM payment_events WHERE provider IN('stripe','paypal') AND processed_at IS NOT NULL AND processing_error IS NULL AND created_at >= $1 AND created_at < $2 ORDER BY created_at`,[start,end]);
  let grossMinor=0,refundMinor=0;const target=reporting.currency;
  for(const row of result.rows){
    const payment=revenueFromEvent(row);if(payment)grossMinor+=reportingCurrency.convertMinor(Number(payment.minor||0),payment.currency||target,target,reporting);
    const refund=dashboardLedger.refundFromEvent(row);if(refund)refundMinor+=reportingCurrency.convertMinor(Number(refund.minor||0),refund.currency||target,target,reporting);
  }
  return{grossMinor,refundMinor,netMinor:grossMinor-refundMinor};
}

async function profitSummary(start,end,reporting,{expenseRows=null}={}){
  const rows=expenseRows||await expenses.list();
  const convert=(minor,from,to)=>reportingCurrency.convertMinor(minor,from,to,reporting);
  const [revenue]=await Promise.all([revenueSummary(start,end,reporting)]);
  const booked=expenses.summarize(rows,start,end,convert,reporting.currency);
  return{start,end,revenue,expenses:booked,profitMinor:revenue.netMinor-booked.totalMinor};
}

function utcDayAfter(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()+1));}
function monthStart(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),1));}
function yearStart(value){const d=new Date(value);return new Date(Date.UTC(d.getUTCFullYear(),0,1));}
function mondayStart(value){const d=new Date(value),day=d.getUTCDay(),offset=(day+6)%7;return new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth(),d.getUTCDate()-offset));}
function addDays(value,days){return new Date(new Date(value).getTime()+Number(days)*86400000);}

async function dashboardProfitability(reporting,{now=new Date(),weeks=8}={}){
  const expenseRows=await expenses.list();
  const currentStart=monthStart(now),currentEnd=utcDayAfter(now),previousStart=monthStart(addDays(currentStart,-1)),ytdStart=yearStart(now);
  const weekCount=Math.max(1,Math.min(26,Number(weeks)||8)),thisWeek=mondayStart(now),firstWeek=addDays(thisWeek,-7*(weekCount-1));
  const windows=[];for(let i=0;i<weekCount;i+=1){const start=addDays(firstWeek,i*7),end=i===weekCount-1?currentEnd:addDays(start,7);windows.push({start,end,label:start.toLocaleDateString('en-GB',{day:'2-digit',month:'short',timeZone:'UTC'})});}
  const [current,previous,ytd,...weekly]=await Promise.all([
    profitSummary(currentStart,currentEnd,reporting,{expenseRows}),
    profitSummary(previousStart,currentStart,reporting,{expenseRows}),
    profitSummary(ytdStart,currentEnd,reporting,{expenseRows}),
    ...windows.map(window=>profitSummary(window.start,window.end,reporting,{expenseRows}))
  ]);
  return{
    currency:reporting.currency,current,previous,ytd,
    weekly:weekly.map((row,index)=>({label:windows[index].label,receipts:row.revenue.netMinor,expenses:row.expenses.totalMinor,profit:row.profitMinor}))
  };
}

module.exports={revenueSummary,profitSummary,dashboardProfitability,monthStart,yearStart,utcDayAfter,mondayStart};
