'use strict';

const { query } = require('../db');
const { dashboardData } = require('./admin-dashboard-data');
const { dashboardRange, fillSeries } = require('./admin-dashboard-analytics');
const reportingCurrency = require('./reporting-currency');
const subscriptionAnalytics = require('./subscription-analytics');
const profitability = require('./business-profitability');
const fleetDashboard = require('./admin-server-fleet-dashboard');
const registry = require('./admin-dashboard-registry');
const widgets = require('./admin-dashboard-widgets');
const { renderWidgetGrid } = require('./admin-dashboard-page');
const { esc } = require('./admin-html');
const { number, money } = require('./admin-dashboard-format');

const MRR_FILTER = `s.superseded_by IS NULL AND s.status IN('active','trialing') AND s.starts_at<=$1 AND s.current_period_end>$1
      AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\') OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%'))`;
const MONTHLY_EQUIVALENT = `ROUND(COALESCE(s.price_minor_snapshot,p.price_minor)::numeric * CASE COALESCE(s.billing_interval_snapshot,p.billing_interval)
        WHEN 'month' THEN 1 WHEN '6_months' THEN 1.0/6 WHEN 'year' THEN 1.0/12
        ELSE 30.4375/GREATEST(COALESCE(s.duration_days_snapshot,p.duration_days,30),1) END)`;

async function mrrByCurrency(asOf = new Date()) {
    const result = await query(`SELECT COALESCE(s.currency_snapshot,p.currency) currency,SUM(${MONTHLY_EQUIVALENT})::bigint amount_minor,COUNT(*)::int subscriptions FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE ${MRR_FILTER} GROUP BY 1 ORDER BY 2 DESC`, [asOf]);
    return result.rows;
}
function primaryMrr(rows, fallbackCurrency = 'GBP', reporting = null) {
    const subscriptions = rows.reduce((sum, r) => sum + Number(r.subscriptions || 0), 0);
    if (reporting?.currency) { const target = reportingCurrency.cleanCurrency(reporting.currency); return { currency: target, amountMinor: rows.reduce((sum,row)=>sum+reportingCurrency.convertMinor(Number(row.amount_minor||0),row.currency||target,target,reporting),0), subscriptions }; }
    const top=rows[0];return{currency:top?.currency||fallbackCurrency,amountMinor:Number(top?.amount_minor||0),subscriptions};
}
function aggregateConverted(rows, reporting, {nameKey='name', valueKey='amount_minor', countKey=null} = {}) {
    const target=reportingCurrency.cleanCurrency(reporting?.currency||'GBP'),grouped=new Map();
    for(const row of rows||[]){const name=String(row[nameKey]||'Unknown'),current=grouped.get(name)||{name,amount_minor:0,count:0,subscriptions:0};current.amount_minor+=reportingCurrency.convertMinor(Number(row[valueKey]||0),row.currency||target,target,reporting);if(countKey)current[countKey]=Number(current[countKey]||0)+Number(row[countKey]||0);grouped.set(name,current);}
    return[...grouped.values()].sort((a,b)=>Number(b.amount_minor||0)-Number(a.amount_minor||0));
}
async function churnRate(range){return subscriptionAnalytics.churnSummary(range);}
async function newVsCancelledSeries(range){
    const bucket=['day','week','month'].includes(range.bucket)?range.bucket:'day';
    const [newRows,cancelledRows]=await Promise.all([
        query(`SELECT date_trunc('${bucket}',created_at) bucket,COUNT(*)::int n FROM subscriptions WHERE created_at>=$1 AND created_at<$2 GROUP BY 1 ORDER BY 1`,[range.start,range.end]),
        query(`SELECT date_trunc('${bucket}',updated_at) bucket,COUNT(*)::int n FROM subscriptions WHERE status='cancelled' AND updated_at>=$1 AND updated_at<$2 GROUP BY 1 ORDER BY 1`,[range.start,range.end])
    ]);
    const newSeries=fillSeries(range,newRows.rows,['n']),cancelledSeries=fillSeries(range,cancelledRows.rows,['n']);return newSeries.map((row,index)=>({label:row.label,key:row.key,new:row.n,cancelled:cancelledSeries[index]?.n||0}));
}
async function revenueMixByService(reporting){
    const result=await query(`SELECT COALESCE(s.service_type_snapshot,p.service_type) name,COALESCE(s.currency_snapshot,p.currency) currency,SUM(${MONTHLY_EQUIVALENT})::bigint amount_minor FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE ${MRR_FILTER} GROUP BY 1,2 ORDER BY 3 DESC`,[new Date()]);
    return aggregateConverted(result.rows,reporting).map(row=>({name:row.name,count:row.amount_minor}));
}
async function revenueByPlan(reporting,asOf=new Date()){
    const result=await query(`SELECT p.name,COALESCE(s.currency_snapshot,p.currency) currency,SUM(${MONTHLY_EQUIVALENT})::bigint amount_minor,COUNT(*)::int subscriptions FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE ${MRR_FILTER} GROUP BY p.id,p.name,COALESCE(s.currency_snapshot,p.currency) ORDER BY amount_minor DESC`,[asOf]);
    return aggregateConverted(result.rows,reporting,{countKey:'subscriptions'});
}
async function revenueByBillingInterval(reporting,asOf=new Date()){
    const result=await query(`SELECT COALESCE(s.billing_interval_snapshot,p.billing_interval) name,COALESCE(s.currency_snapshot,p.currency) currency,SUM(${MONTHLY_EQUIVALENT})::bigint amount_minor,COUNT(*)::int subscriptions FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE ${MRR_FILTER} GROUP BY 1,2 ORDER BY amount_minor DESC`,[asOf]);
    return aggregateConverted(result.rows,reporting,{countKey:'subscriptions'});
}
async function serviceMix(){
    const result=await query(`SELECT
      (SELECT COUNT(DISTINCT customer_id)::int FROM effective_customer_entitlements WHERE blocked=FALSE AND access_expires_at>NOW() AND COALESCE(is_free_tier,FALSE)=FALSE) jellyfin,
      (SELECT COUNT(DISTINCT customer_id)::int FROM effective_stremio_entitlements WHERE blocked=FALSE AND access_expires_at>NOW() AND COALESCE(is_free_tier,FALSE)=FALSE) stremio,
      (SELECT COUNT(DISTINCT customer_id)::int FROM effective_customer_entitlements WHERE blocked=FALSE AND access_expires_at>NOW() AND COALESCE(is_free_tier,FALSE)=TRUE) free`);
    const row=result.rows[0]||{};return{jellyfin:Number(row.jellyfin||0),stremio:Number(row.stremio||0),free:Number(row.free||0)};
}
function fleetCapacity(rows){const enabled=(rows||[]).filter(row=>row.enabled!==false);return{active:enabled.reduce((sum,row)=>sum+Number(row.fleet_metrics?.active_streams??row.active_streams??0),0),capacity:enabled.reduce((sum,row)=>sum+Number(row.max_users||0),0)};}

async function buildContext(req){
    const range=dashboardRange(req.query||{}),reporting=await reportingCurrency.getForUser(req.session.authUserId);
    const [data,profit,newVsCancelled,mix,fleet]=await Promise.all([dashboardData(range,reporting),profitability.dashboardProfitability(reporting),newVsCancelledSeries(range),serviceMix(),fleetDashboard.dashboardRows()]);
    return{range,reporting,data:{...data,profitability:profit,newVsCancelled,serviceMix:mix,streamGauge:fleetCapacity(fleet)}};
}
registry.registerContextBuilder('main',buildContext);

function pairedBars(rows,currency){
    const max=Math.max(1,...rows.flatMap(row=>[Number(row.receipts||0),Number(row.expenses||0)]));
    return `<div class="profitBars" role="img" aria-label="Weekly net receipts versus booked expenses">${rows.map(row=>`<div class="profitBarRow"><strong>${esc(row.label)}</strong><div class="profitBarTracks"><div><span>Receipts</span><i class="profitBar profitBar--receipts" style="width:${Math.max(2,Math.round(Number(row.receipts||0)/max*100))}%"></i><em>${esc(money(row.receipts,currency))}</em></div><div><span>Expenses</span><i class="profitBar profitBar--expenses" style="width:${Math.max(2,Math.round(Number(row.expenses||0)/max*100))}%"></i><em>${esc(money(row.expenses,currency))}</em></div></div></div>`).join('')}</div>`;
}
function serviceBlocks(mix){return `<div class="serviceMixBlocks"><a href="/admin/users?service=jellyfin" class="serviceMixBlock serviceMixBlock--jellyfin"><span>Jellyfin</span><strong>${esc(number(mix.jellyfin))}</strong><small>paid customers · bundles included</small></a><a href="/admin/users?service=stremio" class="serviceMixBlock serviceMixBlock--stremio"><span>Stremio</span><strong>${esc(number(mix.stremio))}</strong><small>paid customers · bundles included</small></a><a href="/admin/users?free=1" class="serviceMixBlock serviceMixBlock--free"><span>Free</span><strong>${esc(number(mix.free))}</strong><small>current free-tier customers</small></a></div>`;}

registry.register('main','cashFlow',{title:'Weekly receipts vs expenses',subtitle:'Net Stripe + PayPal receipts against booked operating expenses in the reporting currency.',defaultOrder:1,defaultSpan:12,render:async ctx=>pairedBars(ctx.data.profitability.weekly,ctx.data.profitability.currency)});
registry.register('main','newVsCancelled',{title:'New vs cancelled',subtitle:'Subscription starts versus cancellations over the selected range.',defaultOrder:2,defaultSpan:8,render:async ctx=>widgets.stackedAreaChart(ctx.data.newVsCancelled,['new','cancelled'])});
registry.register('main','serviceMix',{title:'Service mix',subtitle:'Current customer access by Jellyfin, Stremio and free tier.',defaultOrder:3,defaultSpan:4,render:async ctx=>serviceBlocks(ctx.data.serviceMix)});

async function renderMain(req){const ctx=await buildContext(req),html=await renderWidgetGrid('main',req,ctx);return{ctx,html:`<link rel="stylesheet" href="/css/admin-profit-dashboard.css">${html}`};}

module.exports={renderMain,buildContext,mrrByCurrency,primaryMrr,churnRate,newVsCancelledSeries,revenueMixByService,revenueByPlan,revenueByBillingInterval,aggregateConverted,serviceMix,fleetCapacity,pairedBars,serviceBlocks};
