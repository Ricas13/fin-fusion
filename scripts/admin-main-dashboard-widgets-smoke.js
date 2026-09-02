'use strict';

const { skipIfNoDatabase } = require('./smoke-db');
if (skipIfNoDatabase('admin main dashboard widgets smoke')) process.exit(0);

const assert=require('assert');
const crypto=require('crypto');
const fs=require('fs');
const path=require('path');
const {query,getPool}=require('../src/db');
const registry=require('../src/platform/admin-dashboard-registry');
const {renderMain,buildContext}=require('../src/platform/admin-dashboard-main');
const {dashboardRange}=require('../src/platform/admin-dashboard-analytics');
const {dashboardPage}=require('../src/platform/admin-dashboard');
const profitability=require('../src/platform/business-profitability');
const dashboardLedger=require('../src/payments/dashboard-ledger');
const reportingCurrency=require('../src/platform/reporting-currency');

function fakeReq(adminId,queryParams={}){return{session:{authUserId:adminId,authRole:'admin',adminId},query:queryParams};}
async function seedAdmin(suffix){const inserted=await query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`,[`main-dashboard-${suffix}`]);return inserted.rows[0].id;}
async function seedBusinessData(suffix){
  const plan=(await query(`INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order) VALUES($1,'Main Dashboard Smoke','direct','jellyfin','month',30,999,'USD',3,TRUE,TRUE,999) RETURNING id`,[`main-dashboard-smoke-${suffix}`])).rows[0];
  const customer=(await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Widget Customer',$1,NOW()-INTERVAL '10 days') RETURNING id`,[`widget-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','stripe',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days',$3,'jellyfin')`,[customer.id,plan.id,`sub_smoke_${suffix}`]);
  const churned=(await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Churned Widget Customer',$1,NOW()-INTERVAL '40 days') RETURNING id`,[`churned-widget-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,updated_at) VALUES($1,$2,'expired','manual',NOW()-INTERVAL '35 days',NOW()-INTERVAL '1 day',NOW()-INTERVAL '1 day')`,[churned.id,plan.id]);

  const stremioPlan=(await query(`INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order) VALUES($1,'Stremio Dashboard Smoke','direct','stremio','month',30,699,'USD',2,TRUE,TRUE,998) RETURNING id`,[`stremio-dashboard-smoke-${suffix}`])).rows[0];
  const stremioCustomer=(await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Stremio Widget Customer',$1,NOW()-INTERVAL '4 days') RETURNING id`,[`stremio-widget-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot) VALUES($1,$2,'active','manual',NOW()-INTERVAL '2 days',NOW()+INTERVAL '28 days','stremio')`,[stremioCustomer.id,stremioPlan.id]);

  const freePlan=(await query(`SELECT id FROM plans WHERE is_free_tier=TRUE ORDER BY created_at NULLS LAST LIMIT 1`)).rows[0];
  assert(freePlan,'clean install must provide the canonical free tier for dashboard coverage');
  const freeCustomer=(await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Free Widget Customer',$1,NOW()) RETURNING id`,[`free-widget-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot) VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 day','jellyfin')`,[freeCustomer.id,freePlan.id]);

  const importRun=(await query(`INSERT INTO payment_history_import_runs(provider_scope,range_start,range_end,status,total_seen,imported_count,completed_at) VALUES('both',CURRENT_DATE,CURRENT_DATE,'completed',4,4,NOW()) RETURNING id`)).rows[0];
  const historyRows=[
    ['stripe',`ch_profit_${suffix}`,'charge','succeeded','5 minutes',150000],
    ['paypal',`T_profit_${suffix}`,'T0000','S','4 minutes',81060],
    ['stripe',`re_profit_${suffix}`,'refund','succeeded','3 minutes',-3030],
    ['stripe',`po_profit_${suffix}`,'payout','paid','2 minutes',999999]
  ];
  for(const [provider,id,type,status,age,gross] of historyRows){
    await query(`INSERT INTO payment_history_transactions(provider,provider_transaction_id,transaction_type,transaction_status,occurred_at,currency,gross_amount_minor,first_import_run_id,last_import_run_id) VALUES($1,$2,$3,$4,NOW()-($5::text)::interval,'USD',$6,$7,$7)`,[provider,id,type,status,age,gross,importRun.id]);
  }
  const expense=(await query(`INSERT INTO business_expenses(name,category,amount_minor,currency,recurrence,start_date,active) VALUES($1,'Hosting',88844,'USD','one_time',CURRENT_DATE,TRUE) RETURNING id`,[`Profit smoke ${suffix}`])).rows[0];
  return{importRunId:importRun.id,expenseId:expense.id};
}

async function main(){
  const suffix=crypto.randomBytes(5).toString('hex'),adminId=await seedAdmin(suffix),fixture=await seedBusinessData(suffix);const req=fakeReq(adminId),ctx=await buildContext(req);
  try{
    const specs=registry.listWidgets('main'),expected=['activeSubscribers','newVsChurn','netGrowth','subscriptionsByPlan','churnRate','mrrTrend','activeStreamsTrend','playMethodBreakdown','mostUsedPlayers'];
    assert.deepStrictEqual(specs.map(spec=>spec.key),expected,'Main dashboard must expose the nine growth/server analytics cards in stable order');
    assert(specs.every(spec=>Number(spec.defaultSpan)===4),'all nine analytics cards must default to one third of the 12-column grid');
    for(const spec of specs){const html=await spec.render(ctx);assert(typeof html==='string'&&html.length>0,`widget ${spec.key} must render non-empty HTML`);}
    assert(ctx.data.profitability&&Number.isFinite(Number(ctx.data.profitability.current.profitMinor)),'dashboard must expose current-month profit');
    assert(ctx.data.profitability&&Number.isFinite(Number(ctx.data.profitability.ytd.profitMinor)),'dashboard must expose YTD profit');
    assert(ctx.data.streamGauge&&Number.isFinite(Number(ctx.data.streamGauge.active))&&Number.isFinite(Number(ctx.data.streamGauge.capacity)),'dashboard must expose live streams over sellable capacity');
    assert(ctx.data.growthAnalytics,'dashboard must expose canonical growth/server analytics data');
    assert(Array.isArray(ctx.data.growthAnalytics.growth.rows)&&ctx.data.growthAnalytics.growth.rows.length>0,'growth analytics must expose a filled historical series');
    assert(Number(ctx.data.growthAnalytics.growth.current)>=1,'paid active subscriber series must count the seeded paid customer');
    assert(Array.isArray(ctx.data.growthAnalytics.plans.rows)&&ctx.data.growthAnalytics.plans.series.length>=1,'plan analytics must expose historical plan series');
    assert(Array.isArray(ctx.data.growthAnalytics.mrr.rows),'MRR analytics must expose a range-adjusted series');
    assert(Array.isArray(ctx.data.growthAnalytics.playback.rows),'server analytics must expose playback/concurrency buckets even when playback history is empty');
    assert(Array.isArray(ctx.data.growthAnalytics.players.rows),'player analytics must expose a normalized player ranking');
    assert(ctx.data.serviceMix&&['jellyfin','stremio','free'].every(key=>Number.isFinite(Number(ctx.data.serviceMix[key]))),'compatibility service mix must remain available to other callers');

    const now=new Date(),ytdStart=profitability.yearStart(now),ytdEnd=profitability.utcDayAfter(now),header=await profitability.headerProfitability(ctx.reporting,{now});
    const analyticsYtd=await dashboardLedger.commerceRevenue({start:ytdStart,end:ytdEnd,previousStart:ytdStart,previousEnd:ytdStart,bucket:'month'},ctx.reporting,reportingCurrency);
    assert(analyticsYtd.grossMinor>0,'profit smoke must exercise non-zero imported provider history');
    assert.equal(header.ytd.revenue.netMinor,analyticsYtd.netMinor,'header YTD net receipts must equal Commerce Analytics net receipts for the same YTD window and reporting currency');
    assert.equal(ctx.data.profitability.ytd.revenue.netMinor,analyticsYtd.netMinor,'dashboard YTD net receipts must equal Commerce Analytics net receipts for the same YTD window and reporting currency');
    assert.equal(header.ytd.profitMinor,header.ytd.revenue.netMinor-header.ytd.expenses.totalMinor,'header YTD profit must be canonical net receipts minus booked expenses');

    const mainSource=fs.readFileSync(path.join(__dirname,'..','src/platform/admin-dashboard-main.js'),'utf8');
    const growthSource=fs.readFileSync(path.join(__dirname,'..','src/platform/admin-dashboard-growth-data.js'),'utf8');
    const dashboardSource=fs.readFileSync(path.join(__dirname,'..','src/platform/admin-dashboard.js'),'utf8');
    const publicAuthSource=fs.readFileSync(path.join(__dirname,'..','src/platform/customer-public-auth.js'),'utf8');
    assert(mainSource.includes("require('./business-profitability')")&&mainSource.includes('profitability.dashboardProfitability'),'home dashboard profit must use the shared profitability owner');
    assert(mainSource.includes("require('./admin-dashboard-growth-data')")&&mainSource.includes('growthData.growthServerAnalytics'),'home dashboard growth/server cards must use their canonical data owner');
    for(const key of expected)assert(mainSource.includes(`registry.register('main','${key}'`),`home dashboard must register ${key}`);
    assert(growthSource.includes('date_trunc')&&growthSource.includes('generate_series'),'time-adjusted analytics must bucket historical data in PostgreSQL rather than fabricate client-side points');
    assert(growthSource.includes('reactivations')&&growthSource.includes('opening_active')&&growthSource.includes('churn_rate'),'growth series must distinguish reactivation and preserve the opening churn denominator');
    assert(growthSource.includes('avg_concurrent')&&growthSource.includes('directplay_seconds')&&growthSource.includes('directstream_seconds')&&growthSource.includes('transcode_seconds'),'server analytics must derive concurrency and play-method watch time from playback history');
    assert(dashboardSource.includes('Profit this month')&&dashboardSource.includes('Profit YTD')&&dashboardSource.includes('used / sellable stream capacity')&&dashboardSource.includes('Needs attention'),'dashboard hero must keep the original top signals');
    assert(dashboardSource.includes('renderLiveStreamsPanel(req)'),'existing live playback panel must remain intact above analytics');
    assert(!dashboardSource.includes('attentionOverview(stats)')&&!dashboardSource.includes("label: 'MRR'"),'home dashboard must not duplicate the old attention block or MRR tile');
    assert(publicAuthSource.includes('verificationRequired:true'),'public registration page must always disclose email verification');
    assert(!publicAuthSource.includes('runtimeSettings.requireEmailVerification()'),'public registration must not have a bypass around verification');

    const{html}=await renderMain(req);assert(html.includes('data-dashboard-key="main"'),'rendered page must expose the widget-drag root');assert(html.includes('/css/admin-profit-dashboard.css'),'rendered page must load profit-dashboard styling');assert(html.includes('/css/admin-dashboard-growth.css'),'rendered page must load growth/server chart styling');assert(html.includes('Growth & server analytics'),'rendered page must label the new section');assert(html.includes('/js/admin-dashboard-widgets.js'),'rendered page must preserve dashboard customization');
    const lower=html.toLowerCase();for(const banned of ['api_key','apikey','password_hash','session_secret'])assert(!lower.includes(banned),`dashboard HTML must never include a ${banned}-shaped string`);
    const emptyRange=dashboardRange({range:'7d'},new Date('2000-01-01T00:00:00.000Z')),emptyCtx={...ctx,range:emptyRange,data:{...ctx.data,growthAnalytics:{...ctx.data.growthAnalytics,growth:{...ctx.data.growthAnalytics.growth,rows:[]},plans:{...ctx.data.growthAnalytics.plans,rows:[]},mrr:{...ctx.data.growthAnalytics.mrr,rows:[]},playback:{...ctx.data.growthAnalytics.playback,rows:[]},players:{rows:[]}}}};for(const spec of specs)await spec.render(emptyCtx);
    let sentBody=null;const fakeRes={setHeader(){},send(body){sentBody=body;return fakeRes;}};await dashboardPage(req,fakeRes);assert(typeof sentBody==='string'&&sentBody.includes('Profit this month')&&sentBody.includes('data-admin-live-streams')&&sentBody.includes('Growth & server analytics'),'/admin must render top KPIs, Live Playback and the new analytics section end to end');
    console.log('admin main dashboard widgets smoke: ok');
  }finally{
    await query('DELETE FROM payment_history_transactions WHERE last_import_run_id=$1',[fixture.importRunId]).catch(()=>{});
    await query('DELETE FROM payment_history_import_runs WHERE id=$1',[fixture.importRunId]).catch(()=>{});
    await query('DELETE FROM business_expenses WHERE id=$1',[fixture.expenseId]).catch(()=>{});
  }
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{try{await getPool().end();}catch(_){}});
