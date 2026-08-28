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

function fakeReq(adminId,queryParams={}){return{session:{authUserId:adminId,authRole:'admin',adminId},query:queryParams};}
async function seedAdmin(suffix){const inserted=await query(`INSERT INTO app_users(username,password_hash,role,active) VALUES($1,'x','admin',TRUE) RETURNING id`,[`main-dashboard-${suffix}`]);return inserted.rows[0].id;}
async function seedBusinessData(suffix){
  const plan=(await query(`INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order) VALUES($1,'Main Dashboard Smoke','direct','jellyfin','month',30,999,'USD',3,TRUE,TRUE,999) RETURNING id`,[`main-dashboard-smoke-${suffix}`])).rows[0];
  const customer=(await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Widget Customer',$1,NOW()) RETURNING id`,[`widget-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,provider_subscription_id,service_type_snapshot) VALUES($1,$2,'active','stripe',NOW()-INTERVAL '5 days',NOW()+INTERVAL '25 days',$3,'jellyfin')`,[customer.id,plan.id,`sub_smoke_${suffix}`]);
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,updated_at) VALUES($1,$2,'cancelled','manual',NOW()-INTERVAL '20 days',NOW()-INTERVAL '1 days',NOW()-INTERVAL '1 days')`,[customer.id,plan.id]);

  const stremioPlan=(await query(`INSERT INTO plans(code,name,audience,service_type,billing_interval,duration_days,price_minor,currency,streams,active,visible,sort_order) VALUES($1,'Stremio Dashboard Smoke','direct','stremio','month',30,699,'USD',2,TRUE,TRUE,998) RETURNING id`,[`stremio-dashboard-smoke-${suffix}`])).rows[0];
  const stremioCustomer=(await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Stremio Widget Customer',$1,NOW()) RETURNING id`,[`stremio-widget-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot) VALUES($1,$2,'active','manual',NOW()-INTERVAL '2 days',NOW()+INTERVAL '28 days','stremio')`,[stremioCustomer.id,stremioPlan.id]);

  const freePlan=(await query(`SELECT id FROM plans WHERE is_free_tier=TRUE ORDER BY created_at NULLS LAST LIMIT 1`)).rows[0];
  assert(freePlan,'clean install must provide the canonical free tier for dashboard service-mix coverage');
  const freeCustomer=(await query(`INSERT INTO customers(display_name,email,created_at) VALUES('Free Widget Customer',$1,NOW()) RETURNING id`,[`free-widget-${suffix}@example.invalid`])).rows[0];
  await query(`INSERT INTO subscriptions(customer_id,plan_id,status,source,starts_at,current_period_end,service_type_snapshot) VALUES($1,$2,'active','manual',NOW()-INTERVAL '1 day',NOW()+INTERVAL '1 day','jellyfin')`,[freeCustomer.id,freePlan.id]);
}

async function main(){
  const suffix=crypto.randomBytes(5).toString('hex'),adminId=await seedAdmin(suffix);await seedBusinessData(suffix);const req=fakeReq(adminId),ctx=await buildContext(req);
  const specs=registry.listWidgets('main');
  assert.deepStrictEqual(specs.map(spec=>spec.key),['cashFlow','newVsCancelled','serviceMix'],'Main dashboard must expose only the requested three content widgets');
  for(const spec of specs){const html=await spec.render(ctx);assert(typeof html==='string'&&html.length>0,`widget ${spec.key} must render non-empty HTML`);}
  assert(ctx.data.profitability&&Number.isFinite(Number(ctx.data.profitability.current.profitMinor)),'dashboard must expose current-month profit');
  assert(ctx.data.profitability&&Number.isFinite(Number(ctx.data.profitability.ytd.profitMinor)),'dashboard must expose YTD profit');
  assert(Array.isArray(ctx.data.profitability.weekly)&&ctx.data.profitability.weekly.length>0,'dashboard must expose weekly receipts and expenses');
  assert(ctx.data.streamGauge&&Number.isFinite(Number(ctx.data.streamGauge.active))&&Number.isFinite(Number(ctx.data.streamGauge.capacity)),'dashboard must expose live streams over sellable capacity');
  assert(ctx.data.serviceMix&&['jellyfin','stremio','free'].every(key=>Number.isFinite(Number(ctx.data.serviceMix[key]))),'dashboard must expose Jellyfin/Stremio/free service mix');
  assert(Number(ctx.data.serviceMix.jellyfin)>=1,'service mix must count current Jellyfin-lane paid access');
  assert(Number(ctx.data.serviceMix.stremio)>=1,'service mix must count current standalone Stremio access from the Stremio entitlement lane');
  assert(Number(ctx.data.serviceMix.free)>=1,'service mix must count current Free Access from the Jellyfin entitlement lane');
  assert(Array.isArray(ctx.data.newVsCancelled),'dashboard must reuse the new-vs-cancelled series');

  const mainSource=fs.readFileSync(path.join(__dirname,'..','src/platform/admin-dashboard-main.js'),'utf8');
  const dashboardSource=fs.readFileSync(path.join(__dirname,'..','src/platform/admin-dashboard.js'),'utf8');
  const publicAuthSource=fs.readFileSync(path.join(__dirname,'..','src/platform/customer-public-auth.js'),'utf8');
  assert(mainSource.includes("require('./business-profitability')")&&mainSource.includes('profitability.dashboardProfitability'),'home dashboard profit must use the shared profitability owner');
  assert(mainSource.includes('FROM effective_customer_entitlements')&&mainSource.includes('FROM effective_stremio_entitlements')&&mainSource.includes('blocked=FALSE AND access_expires_at>NOW()'),'service mix must use the separate canonical Jellyfin and Stremio effective-access lanes rather than raw billing status');
  assert(mainSource.includes("registry.register('main','cashFlow'")&&mainSource.includes("registry.register('main','newVsCancelled'")&&mainSource.includes("registry.register('main','serviceMix'"),'home dashboard must register only cash flow, growth and service mix content');
  for(const retired of ["registry.register('main', 'mrr'","registry.register('main', 'revenueTrend'","registry.register('main', 'revenueMix'","registry.register('main', 'planDistribution'"])assert(!mainSource.includes(retired),`${retired} must not remain on the home dashboard`);
  assert(dashboardSource.includes('Profit this month')&&dashboardSource.includes('Profit YTD')&&dashboardSource.includes('used / sellable stream capacity')&&dashboardSource.includes('Needs attention'),'dashboard hero must contain the four requested signals');
  assert(!dashboardSource.includes('attentionOverview(stats)')&&!dashboardSource.includes("label: 'MRR'"),'home dashboard must not duplicate the old attention block or MRR tile');
  assert(publicAuthSource.includes('verificationRequired:true'),'public registration page must always disclose email verification');
  assert(!publicAuthSource.includes('runtimeSettings.requireEmailVerification()'),'public registration must not have a bypass around verification');
  assert(!publicAuthSource.includes('customers.registerCustomer'),'public registration must create accounts only through verified pending registrations');
  assert(!publicAuthSource.includes('Email is required')&&!publicAuthSource.includes('email required'),'public auth must not add a duplicate email-required validation rule');

  const{html}=await renderMain(req);assert(html.includes('data-dashboard-key="main"'),'rendered page must expose the widget-drag root');assert(html.includes('/css/admin-profit-dashboard.css'),'rendered page must load profit-dashboard styling');assert(html.includes('/js/admin-dashboard-widgets.js'),'rendered page must load dashboard customization');
  const lower=html.toLowerCase();for(const banned of ['api_key','apikey','password_hash','session_secret'])assert(!lower.includes(banned),`dashboard HTML must never include a ${banned}-shaped string`);
  const emptyRange=dashboardRange({range:'7d'},new Date('2000-01-01T00:00:00.000Z')),emptyCtx={...ctx,range:emptyRange,data:{...ctx.data,range:emptyRange,newVsCancelled:[]}};for(const spec of specs)await spec.render(emptyCtx);
  let sentBody=null;const fakeRes={setHeader(){},send(body){sentBody=body;return fakeRes;}};await dashboardPage(req,fakeRes);assert(typeof sentBody==='string'&&sentBody.includes('Profit this month')&&sentBody.includes('data-dashboard-key="main"'),'/admin must render the profit-first dashboard end to end');
  console.log('admin main dashboard widgets smoke: ok');
}
main().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{try{await getPool().end();}catch(_){}});
