'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const dashboard=read('src/platform/admin-dashboard.js');
const view=read('src/platform/admin-dashboard-view.js');
const viewUtils=read('src/platform/admin-dashboard-view-utils.js');
const main=read('src/platform/admin-dashboard-main.js');
const growthData=read('src/platform/admin-dashboard-growth-data.js');
const growthView=read('src/platform/admin-dashboard-growth-view.js');
const reporting=read('src/platform/reporting-currency.js');
const profit=read('src/platform/business-profitability.js');
const dashboardCss=read('public/css/admin-profit-dashboard.css');
const growthCss=read('public/css/admin-dashboard-growth.css');

assert(dashboard.includes("require('./admin-dashboard-main')"),'Dashboard must use the widget-registry-based renderer');
assert(!dashboard.includes("require('./admin-dashboard-view-v2')"),'Dashboard must not depend on the retired dashboard renderer path');
assert(view.includes("require('./admin-dashboard-view-utils')"),'Canonical dashboard renderer must use the dedicated view utility module');
assert(view.includes('function renderDashboard'),'Canonical dashboard view must own the reusable renderer implementation');
assert(viewUtils.includes('function barChart')&&viewUtils.includes('function areaChart')&&viewUtils.includes('function rangeControls'),'Dashboard chart and range primitives must retain one dedicated owner');

const expectedWidgets=['activeSubscribers','newVsChurn','netGrowth','subscriptionsByPlan','churnRate','mrrTrend','activeStreamsTrend','playMethodBreakdown','mostUsedPlayers'];
for(const widget of expectedWidgets)assert(main.includes(`registry.register('main','${widget}'`)&&main.match(new RegExp(`registry\\.register\\('main','${widget}'[\\s\\S]*?defaultSpan:4`)),`Main dashboard widget ${widget} must default to one third of the 12-column analytics grid`);
assert(!main.includes("registry.register('main','cashFlow'")&&!main.includes("registry.register('main','serviceMix'"),'legacy below-the-fold dashboard widgets must not remain beside the nine analytics cards');
assert(main.includes('Growth & server analytics')&&main.includes('/css/admin-dashboard-growth.css'),'Dashboard must identify and style the new analytics section');

assert(dashboard.includes('Profit this month')&&dashboard.includes('Profit YTD'),'Dashboard hero must lead with profit');
assert(dashboard.includes('managed customers / configured user capacity')&&dashboard.includes('Needs attention'),'Dashboard hero must keep user capacity and attention intact');
assert(dashboard.includes("renderLiveStreamsPanel(req)"),'Live Playback panel must remain directly owned by the existing live-stream renderer');
assert(dashboard.includes('adminDashboardCompactBody')&&dashboard.includes('profitMetricPair'),'Dashboard must keep the compact top-body contract and paired month/YTD profit');

assert(growthData.includes('before_count=0 AND after_count>0')&&growthData.includes('before_count>0 AND after_count=0'),'growth analytics must derive activation/churn from customer access transitions rather than mutable cancellation timestamps');
assert(growthData.includes('COUNT(DISTINCT s.customer_id)::int active')&&growthData.includes('opening_active'),'active-subscriber and churn-rate series must be customer-level with an opening denominator');
assert(growthData.includes("t.occurred_at<>f.first_at")&&growthView.includes('Reactivated'),'reactivations must be separated from first-time customers so net growth reconciles');
assert(growthData.includes('COALESCE(p.is_free_tier,FALSE)=FALSE')&&growthData.includes('COALESCE(p.is_addon,FALSE)=FALSE'),'headline subscriber growth must exclude free access and add-ons');
assert(growthData.includes("s.source='stripe'")&&growthData.includes("provider_subscription_id,'') LIKE 'sub")&&growthData.includes("s.source='paypal'")&&growthData.includes("provider_subscription_id,'') LIKE 'I-%'"),'MRR trend must include only verified recurring Stripe/PayPal contract identities');
assert(growthData.includes('LEAST(COALESCE(ph.ended_at,ph.last_seen_at),b.bucket_end)')&&growthData.includes('avg_concurrent')&&growthData.includes('bucket_seconds'),'stream history must use duration-weighted playback overlap instead of pretending session starts equal concurrency');
assert(growthData.includes("method='directplay'")&&growthData.includes("method='directstream'")&&growthData.includes("method='transcode'"),'playback trend must keep Direct Play, Direct Stream and Transcode separate');
assert(growthData.includes("if(value.includes('stremio'))return'Stremio'")&&growthData.includes("return'Android TV'")&&growthData.includes("return'Web'"),'player analytics must normalize noisy client/device names into stable player families');
assert(growthData.includes('total=sorted.reduce')&&growthData.includes('rows=sorted.slice(0,9)'),'player shares must use total managed watch time before trimming the displayed top players');

assert(growthView.includes('function movementBars')&&growthView.includes('function signedBars')&&growthView.includes('function stackedArea')&&growthView.includes('function percentStacked'),'analytics renderer must provide dedicated colorful chart primitives for growth and server data');
assert(growthView.includes("sum(rows,'bucket_seconds')")&&growthView.includes('data.players.totalSeconds'),'analytics headline metrics must use duration-weighted concurrency and all-player watch time');
assert(growthCss.includes('--growth-amber:rgb(')&&growthCss.includes('--growth-green:rgb(')&&growthCss.includes('--growth-purple:rgb('),'analytics charts must use a disciplined multi-colour data palette');
assert(growthCss.includes('[data-dashboard-key="main"]>.analyticsCard.widgetCard{height:auto;min-height:300px'),'analytics cards must remain compact instead of inheriting the old full-height stretch regression');
assert(growthCss.includes('@media(max-width:1180px)')&&growthCss.includes('grid-column:span 6')&&growthCss.includes('@media(max-width:820px)'),'3-column analytics cards must collapse to 2 and then 1 columns responsively');

assert(dashboardCss.includes('.profitHeroGrid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr))'),'Dashboard summary must keep the compact three-column top-card rhythm');
assert(profit.includes('revenue.netMinor-booked.totalMinor'),'Profit must remain net provider receipts minus booked expenses');
assert(profit.includes("provider IN('stripe','paypal')"),'Profit must stay aligned with the current Expenses provider scope');
assert(reporting.includes('async function getForUser(_userId)')&&reporting.includes('masterCurrency:true'),'Dashboard reporting currency must resolve to the platform master currency');
assert(reporting.includes('Currency is controlled platform-wide in Settings → Portal currency')&&!reporting.includes('UPDATE app_users SET preferred_currency'),'Per-user reporting currency preference must remain retired');

console.log('dashboard business layout smoke: ok');
