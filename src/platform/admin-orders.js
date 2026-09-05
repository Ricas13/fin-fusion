'use strict';

const express=require('express');
const {query}=require('../db');
const runtimeSettings=require('./runtime-settings');
const readCursors=require('./operator-read-cursors');
const {esc,layout}=require('./admin-html');
const moneyFormat=require('./money-format');
const dashboardWidgets=require('./admin-dashboard-widgets');
const {fillSeries}=require('./admin-dashboard-analytics');
const commerceDashboard=require('./admin-commerce-dashboard');
const reportingCurrency=require('./reporting-currency');
const profitability=require('./business-profitability');
const incidents=require('../payments/incidents');
const commercialPolicies=require('./admin-commercial-policies');

const ORDERS_PATH='/admin/commerce/orders';
const LEGACY_ORDERS_PATH='/admin/orders';
const PAGE_SIZE=10;
const RANGE_OPTIONS=[['7d','Weekly'],['30d','Monthly'],['90d','3 months'],['180d','6 months'],['365d','1 year'],['ytd','YTD'],['all','Since beginning'],['custom','Specific time frame']];

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function when(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleString('en-GB',{dateStyle:'medium',timeStyle:'short'});}
function day(value){if(!value)return'—';const d=new Date(value);return Number.isNaN(d.getTime())?'—':d.toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'});}
function iso(value){const d=new Date(value);return Number.isNaN(d.getTime())?'':d.toISOString().slice(0,10);}
function number(value){return Number(value||0).toLocaleString('en-GB');}
function statusKind(status){return status==='past_due'?'warn':['active','trialing','completed','succeeded'].includes(status)?'good':['cancelled','expired','failed'].includes(status)?'bad':'';}
function titleCase(value){return String(value||'').replace(/_/g,' ').replace(/\b\w/g,m=>m.toUpperCase());}
function money(minor,currency='GBP'){return moneyFormat.formatMinor(Number(minor||0),currency||'GBP',{trimZeroDecimals:true});}
function rangeLabel(key){return RANGE_OPTIONS.find(([value])=>value===key)?.[1]||'Monthly';}
function pctDelta(current,previous){const a=Number(current||0),b=Number(previous||0);if(!b)return a?null:0;return((a-b)/b)*100;}
function hidden(name,value){return value!==undefined&&value!==null&&String(value)!==''?`<input type="hidden" name="${esc(name)}" value="${esc(value)}">`:'';}
function monthlyEquivalentSql(alias='s',plan='p'){return `CASE COALESCE(NULLIF(${alias}.billing_interval_snapshot,''),${plan}.billing_interval,'month') WHEN '6_months' THEN COALESCE(${alias}.price_minor_snapshot,${plan}.price_minor,0)/6.0 WHEN 'year' THEN COALESCE(${alias}.price_minor_snapshot,${plan}.price_minor,0)/12.0 ELSE COALESCE(${alias}.price_minor_snapshot,${plan}.price_minor,0) END`;}

async function analyticsQuery(raw={}){
 const requested=RANGE_OPTIONS.some(([key])=>key===raw.range)?raw.range:'30d';
 if(requested==='ytd'){
  const now=new Date(),from=new Date(Date.UTC(now.getUTCFullYear(),0,1));
  return{range:'custom',from:iso(from),to:iso(now),displayRange:'ytd'};
 }
 if(requested==='all'){
  const earliest=await query(`SELECT LEAST(
    COALESCE((SELECT MIN(created_at) FROM payment_events),'infinity'::timestamptz),
    COALESCE((SELECT MIN(created_at) FROM subscriptions WHERE source IN('stripe','paypal')),'infinity'::timestamptz),
    COALESCE((SELECT MIN(created_at) FROM billing_checkout_intents),'infinity'::timestamptz)
  ) earliest`);
  const now=new Date(),candidate=new Date(earliest.rows[0]?.earliest||now),maxStart=new Date(now.getTime()-1094*86400000);
  const from=Number.isNaN(candidate.getTime())?maxStart:(candidate<maxStart?maxStart:candidate);
  return{range:'custom',from:iso(from),to:iso(now),displayRange:'all'};
 }
 if(requested==='custom')return{range:'custom',from:String(raw.from||''),to:String(raw.to||''),displayRange:'custom'};
 return{range:requested,displayRange:requested};
}

function parsePurchaseFilters(q,analyticsRange){
 const page=Math.max(1,parseInt(q.page,10)||1),f={page};
 if(q.orderQ)f.q=String(q.orderQ).trim().slice(0,120);
 if(['active','trialing','past_due','paused','cancelled','expired'].includes(q.orderStatus))f.status=q.orderStatus;
 if(['stripe','paypal'].includes(q.orderProvider))f.provider=q.orderProvider;
 if(/^[0-9a-f-]{36}$/i.test(String(q.orderPlan||'')))f.planId=q.orderPlan;
 f.from=/^\d{4}-\d{2}-\d{2}$/.test(String(q.orderFrom||''))?q.orderFrom:analyticsRange.from;
 f.to=/^\d{4}-\d{2}-\d{2}$/.test(String(q.orderTo||''))?q.orderTo:analyticsRange.to;
 return f;
}
function purchaseWhere(filters){
 const clauses=[`s.source IN ('stripe','paypal')`],params=[];const p=value=>{params.push(value);return`$${params.length}`;};
 if(filters.q){const idx=p(`%${filters.q}%`);clauses.push(`(COALESCE(c.display_name,'') ILIKE ${idx} OR COALESCE(c.email,'') ILIKE ${idx} OR COALESCE(u.email,'') ILIKE ${idx} OR COALESCE(u.username,'') ILIKE ${idx} OR COALESCE(s.provider_subscription_id,'') ILIKE ${idx})`);}
 if(filters.status)clauses.push(`s.status=${p(filters.status)}`);
 if(filters.provider)clauses.push(`s.source=${p(filters.provider)}`);
 if(filters.planId)clauses.push(`s.plan_id=${p(filters.planId)}`);
 if(filters.from)clauses.push(`s.created_at>=${p(filters.from)}::date`);
 if(filters.to)clauses.push(`s.created_at<(${p(filters.to)}::date+INTERVAL '1 day')`);
 return{sql:`WHERE ${clauses.join(' AND ')}`,params};
}
async function purchases(filters){
 const where=purchaseWhere(filters),offset=(filters.page-1)*PAGE_SIZE;
 const base=`FROM subscriptions s JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN plans p ON p.id=s.plan_id ${where.sql}`;
 const [countResult,rowResult]=await Promise.all([
  query(`SELECT COUNT(*)::int n ${base}`,where.params),
  query(`SELECT s.id,s.customer_id,s.status,s.source,s.created_at,s.provider_subscription_id,s.price_minor_snapshot,s.currency_snapshot,s.plan_id,COALESCE(NULLIF(s.plan_name_snapshot,''),p.name) plan_name,COALESCE(NULLIF(s.plan_code_snapshot,''),p.code) plan_code,c.display_name,COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) customer_email,u.username customer_username ${base} ORDER BY s.created_at DESC LIMIT ${PAGE_SIZE} OFFSET ${offset}`,where.params)
 ]);
 return{rows:rowResult.rows,total:Number(countResult.rows[0]?.n||0),page:filters.page,pages:Math.max(1,Math.ceil(Number(countResult.rows[0]?.n||0)/PAGE_SIZE))};
}
async function planOptions(){return(await query(`SELECT id,name FROM plans WHERE COALESCE(is_addon,FALSE)=FALSE ORDER BY sort_order,name`)).rows;}

async function periodBreakdowns(range){
 const monthly=monthlyEquivalentSql('s','p');
 const [intervals,services,plans,intents,churn]=await Promise.all([
  query(`SELECT COALESCE(NULLIF(s.billing_interval_snapshot,''),p.billing_interval,'Other') name,SUM(COALESCE(s.price_minor_snapshot,p.price_minor,0))::bigint amount FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.source IN('stripe','paypal') AND s.created_at>=$1 AND s.created_at<$2 GROUP BY 1 ORDER BY amount DESC`,[range.start,range.end]),
  query(`SELECT CASE COALESCE(NULLIF(s.service_type_snapshot,''),p.service_type,'jellyfin') WHEN 'jellyfin' THEN 'Game Servers' WHEN 'stremio' THEN 'Voice Servers' WHEN 'bundle' THEN 'Add-ons' ELSE 'Other' END name,ROUND(SUM(${monthly}))::bigint amount FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.source IN('stripe','paypal') AND s.created_at>=$1 AND s.created_at<$2 GROUP BY 1 ORDER BY amount DESC`,[range.start,range.end]),
  query(`SELECT COALESCE(NULLIF(s.plan_name_snapshot,''),p.name,'Plan') name,COUNT(*)::int purchases,ROUND(SUM(${monthly}))::bigint amount FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.source IN('stripe','paypal') AND s.created_at>=$1 AND s.created_at<$2 GROUP BY 1 ORDER BY purchases DESC,amount DESC LIMIT 7`,[range.start,range.end]),
  query(`SELECT state name,COUNT(*)::int count FROM billing_checkout_intents WHERE created_at>=$1 AND created_at<$2 GROUP BY state ORDER BY count DESC`,[range.start,range.end]),
  query(`SELECT
    COALESCE(SUM(${monthly}) FILTER(WHERE s.status IN('cancelled','expired') AND s.updated_at>=$1 AND s.updated_at<$2),0)::bigint churned,
    COALESCE(SUM(${monthly}) FILTER(WHERE s.created_at>=$1 AND s.created_at<$2 AND EXISTS(SELECT 1 FROM subscriptions old WHERE old.customer_id=s.customer_id AND old.id<>s.id AND old.created_at<s.created_at AND old.status IN('cancelled','expired'))),0)::bigint recovered
   FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE COALESCE(p.is_addon,FALSE)=FALSE`,[range.start,range.end])
 ]);
 return{intervals:intervals.rows,services:services.rows,plans:plans.rows,intents:intents.rows,churn:churn.rows[0]||{churned:0,recovered:0}};
}
async function overdueRevenue(reporting){
 const result=await query(`SELECT COALESCE(NULLIF(s.currency_snapshot,''),p.currency,'GBP') currency,SUM(COALESCE(s.price_minor_snapshot,p.price_minor,0))::bigint amount FROM subscriptions s JOIN plans p ON p.id=s.plan_id WHERE s.status='past_due' AND s.superseded_by IS NULL GROUP BY 1`);
 return result.rows.reduce((sum,row)=>sum+reportingCurrency.convertMinor(Number(row.amount||0),row.currency,reporting.currency,reporting),0);
}
async function renewalRows(){return(await query(`SELECT s.customer_id,s.current_period_end,s.price_minor_snapshot,s.currency_snapshot,COALESCE(NULLIF(s.plan_name_snapshot,''),p.name) plan_name,COALESCE(NULLIF(c.display_name,''),NULLIF(u.username,''),NULLIF(c.email,''),NULLIF(u.email,''),'Customer') customer FROM subscriptions s JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN plans p ON p.id=s.plan_id WHERE s.source IN('stripe','paypal') AND s.status IN('active','trialing') AND COALESCE(s.cancel_at_period_end,FALSE)=FALSE AND s.provider_subscription_id IS NOT NULL AND s.current_period_end>NOW() AND s.current_period_end<=NOW()+INTERVAL '7 days' ORDER BY s.current_period_end LIMIT 12`)).rows;}
async function expiryRows(){return(await query(`SELECT s.customer_id,s.current_period_end,s.status,COALESCE(NULLIF(s.plan_name_snapshot,''),p.name) plan_name,COALESCE(NULLIF(c.display_name,''),NULLIF(u.username,''),NULLIF(c.email,''),NULLIF(u.email,''),'Customer') customer FROM subscriptions s JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN plans p ON p.id=s.plan_id WHERE s.superseded_by IS NULL AND s.current_period_end>NOW() AND s.current_period_end<=NOW()+INTERVAL '30 days' AND (COALESCE(s.cancel_at_period_end,FALSE)=TRUE OR s.status='trialing' OR s.source NOT IN('stripe','paypal') OR s.provider_subscription_id IS NULL) ORDER BY s.current_period_end LIMIT 100`)).rows;}

function rangeControl(displayRange,range){
 return `<form class="ordersRangeForm" method="get" action="${ORDERS_PATH}" data-orders-range-form><div class="ordersRangeSelect"><span aria-hidden="true">▣</span><label class="srOnly" for="ordersRange">Analytics period</label><select class="input" id="ordersRange" name="range" data-orders-range>${RANGE_OPTIONS.map(([key,label])=>`<option value="${key}" ${displayRange===key?'selected':''}>${esc(label)}</option>`).join('')}</select><small>${esc(range.label)}</small></div><div class="ordersCustomRange" data-orders-custom ${displayRange==='custom'?'':'hidden'}><label>From<input class="input" type="date" name="from" value="${esc(range.from)}"></label><label>To<input class="input" type="date" name="to" value="${esc(range.to)}"></label><button class="button secondary btn-sm">Apply</button></div></form>`;
}
function metricCard(label,value,{delta,meta='',tone=''}={}){return dashboardWidgets.kpiCard({label,value,delta,meta,tone});}
function revenueChart(ctx){
 const currency=ctx.data.revenue.primaryCurrency,buckets=fillSeries(ctx.range,[],[]),rows=buckets.map(point=>{const bucket=ctx.data.revenue.byBucketCurrency.get(point.key)||new Map();return{label:point.label,[currency]:bucket.get(currency)||0};});
 return rows.some(row=>row[currency])?dashboardWidgets.stackedAreaChart(rows,[currency],value=>money(value,currency)):dashboardWidgets.emptyState('No provider payments recorded in this period.');
}
function chartCard(title,subtitle,body,cls=''){return `<section class="ordersChartCard ${cls}"><div class="ordersCardHead"><div><h2>${esc(title)}</h2>${subtitle?`<p>${esc(subtitle)}</p>`:''}</div></div><div class="ordersChartBody">${body}</div></section>`;}
function analyticsGrid(ctx,breakdowns){
 const currency=ctx.data.revenue.primaryCurrency;
 const intervalRows=breakdowns.intervals.map(row=>({name:titleCase(row.name),count:Number(row.amount||0)}));
 const serviceRows=breakdowns.services.map(row=>({name:row.name,count:Number(row.amount||0)}));
 const planRows=breakdowns.plans.map(row=>({label:row.name,count:Number(row.purchases||0)}));
 const intentRows=breakdowns.intents.map(row=>({name:titleCase(row.name),count:Number(row.count||0)}));
 return `<div class="ordersAnalyticsGrid">${chartCard('Revenue over time','Successful provider payments in the selected period.',revenueChart(ctx),'ordersChartWide')}${chartCard('Revenue by billing interval','Purchase revenue by billing interval for this period.',intervalRows.length?dashboardWidgets.donutChart(intervalRows,{formatter:value=>money(value,currency)}):dashboardWidgets.emptyState('No purchases in this period.'))}${chartCard('MRR composition','Monthly-equivalent value of purchases by service type in this period.',serviceRows.length?dashboardWidgets.donutChart(serviceRows,{formatter:value=>money(value,currency)}):dashboardWidgets.emptyState('No recurring revenue in this period.'))}${chartCard('Plan performance','Purchases by plan in the selected period.',planRows.length?dashboardWidgets.barChart(planRows,'count',value=>number(value),{orientation:'horizontal'}):dashboardWidgets.emptyState('No plan purchases in this period.'))}${chartCard('Payment intent status','Checkout intent outcomes created in this period.',intentRows.length?dashboardWidgets.donutChart(intentRows):dashboardWidgets.emptyState('No checkout intents in this period.'))}${chartCard('Churn & recovered revenue','Monthly-equivalent value lost and recovered during this period.',`<div class="ordersRevenuePair"><div><span>Churned revenue</span><strong>${money(breakdowns.churn.churned,currency)}</strong></div><div><span>Recovered revenue</span><strong>${money(breakdowns.churn.recovered,currency)}</strong></div></div>`)} </div>`;
}
function incidentPanel(rows){
 const open=rows.filter(row=>!row.resolved_at).slice(0,7);
 return `<section class="ordersAttention"><div class="ordersAttentionHead"><div><h2>▣ Payment intents to resolve <span class="ordersBadge bad">${open.length}</span></h2><p>Action required for failed, disputed or incomplete payment workflows.</p></div><a href="/admin/payments">View all →</a></div>${open.length?`<div class="tableWrap"><table class="dataTable ordersAttentionTable"><thead><tr><th>Created</th><th>Customer</th><th>Amount</th><th>Method</th><th>Failure reason</th><th>Status</th><th>Action</th></tr></thead><tbody>${open.map(row=>`<tr><td>${esc(when(row.created_at))}</td><td>${row.customer_id?`<a href="/admin/users/${esc(row.customer_id)}?tab=billing">${esc(row.customer_name||'Customer')}</a>`:esc(row.customer_name||'Unresolved')}</td><td>${row.amount_minor!=null?esc(money(row.amount_minor,row.currency||'GBP')):'—'}</td><td>${esc(titleCase(row.provider))}</td><td>${esc(titleCase(row.incident_type))}</td><td><span class="pill ${row.acknowledged_at?'warn':'bad'}">${esc(row.acknowledged_at?'Acknowledged':'Open')}</span></td><td><a class="button secondary btn-sm" href="/admin/payments">Review</a></td></tr>`).join('')}</tbody></table></div>`:'<div class="ordersInlineGood">No unresolved payment issues.</div>'}</section>`;
}
function kpis(ctx,overdue,profit){
 const currency=ctx.data.revenue.primaryCurrency,mrr=ctx.data.mrr,prev=ctx.data.previousMrr;
 return `<div class="ordersKpis">${metricCard('Monthly recurring revenue',money(mrr.amountMinor,mrr.currency),{delta:pctDelta(mrr.amountMinor,prev.amountMinor),meta:'vs. previous period'})}${metricCard('Gross revenue',money(ctx.data.revenue.grossMinor,currency),{delta:pctDelta(ctx.data.revenue.grossMinor,ctx.data.revenue.previousGrossMinor),meta:'vs. previous period'})}${metricCard('Net revenue',money(ctx.data.revenue.netMinor,currency),{delta:pctDelta(ctx.data.revenue.netMinor,ctx.data.revenue.previousNetMinor),meta:'after refunds'})}${metricCard('Overdue revenue',money(overdue,currency),{meta:'current past-due subscriptions',tone:'warn'})}${metricCard('Paying subscribers & ARPU',`${number(ctx.data.revenue.payingCustomers)} · ${money(ctx.data.revenue.arpuMinor,currency)}`,{meta:'customers · average revenue'})}${metricCard('Net profit',money(profit.profitMinor,currency),{meta:'net revenue minus booked expenses',tone:profit.profitMinor<0?'bad':'good'})}</div>`;
}
function renewalStrip(rows,reporting){
 const total=rows.reduce((sum,row)=>sum+reportingCurrency.convertMinor(Number(row.price_minor_snapshot||0),row.currency_snapshot||reporting.currency,reporting.currency,reporting),0),avatars=rows.slice(0,3).map(row=>`<span title="${esc(row.customer)}">${esc(String(row.customer||'?').slice(0,2).toUpperCase())}</span>`).join('');
 return `<section class="ordersRenewalStrip"><div><strong>▣ Upcoming renewals (next 7 days)</strong><span class="ordersBadge">${rows.length} renewals</span><span><b>${esc(money(total,reporting.currency))}</b> estimated revenue</span></div><div class="ordersRenewalActions"><div class="ordersAvatars">${avatars}${rows.length>3?`<span>+${rows.length-3}</span>`:''}</div><a class="button secondary btn-sm" href="/admin/billing">View upcoming</a></div></section>`;
}
function purchaseFilterForm(filters,plans,raw,displayRange){
 return `<form class="ordersPurchaseFilters" method="get" action="${ORDERS_PATH}">${hidden('range',displayRange)}${hidden('from',raw.from)}${hidden('to',raw.to)}<div class="ordersSearch"><span>⌕</span><input class="input" type="search" name="orderQ" value="${esc(filters.q||'')}" placeholder="Search customers, emails or transaction IDs…"></div><select class="input" name="orderStatus"><option value="">All status</option>${['active','trialing','past_due','paused','cancelled','expired'].map(value=>`<option value="${value}" ${filters.status===value?'selected':''}>${esc(titleCase(value))}</option>`).join('')}</select><select class="input" name="orderProvider"><option value="">All providers</option><option value="stripe" ${filters.provider==='stripe'?'selected':''}>Stripe</option><option value="paypal" ${filters.provider==='paypal'?'selected':''}>PayPal</option></select><select class="input" name="orderPlan"><option value="">All plans</option>${plans.map(plan=>`<option value="${esc(plan.id)}" ${filters.planId===plan.id?'selected':''}>${esc(plan.name)}</option>`).join('')}</select><div class="ordersDateFilter"><input class="input" type="date" name="orderFrom" value="${esc(filters.from||'')}"><span>→</span><input class="input" type="date" name="orderTo" value="${esc(filters.to||'')}"></div><button class="button secondary btn-sm">Filter</button><a class="ordersClear" href="${ORDERS_PATH}?range=${encodeURIComponent(displayRange)}${raw.from?`&from=${encodeURIComponent(raw.from)}`:''}${raw.to?`&to=${encodeURIComponent(raw.to)}`:''}">Clear filters</a></form>`;
}
function orderTable(data){
 if(!data.rows.length)return'<div class="empty">No provider purchases match these filters.</div>';
 return `<div class="tableWrap"><table class="dataTable responsiveTable ordersTable"><caption class="srOnly">Stripe and PayPal purchase history</caption><thead><tr><th>Date</th><th>Customer</th><th>Plan</th><th>Provider</th><th>Status</th><th>Actions</th></tr></thead><tbody>${data.rows.map(row=>{const customer=row.display_name||row.customer_username||row.customer_email||row.customer_id;return `<tr><td data-label="Date">${esc(when(row.created_at))}</td><td data-label="Customer"><a class="mediaTitle" href="/admin/users/${esc(row.customer_id)}?tab=billing">${esc(customer)}</a><div class="subText">${esc(row.customer_email||'Open customer billing →')}</div></td><td data-label="Plan"><strong>${esc(row.plan_name||row.plan_code||'Plan')}</strong>${row.price_minor_snapshot!=null?`<div class="subText">${esc(money(row.price_minor_snapshot,row.currency_snapshot||'GBP'))}</div>`:''}</td><td data-label="Provider"><span class="pill ${row.source==='stripe'?'accent':''}">${esc(row.source==='stripe'?'Stripe':'PayPal')}</span></td><td data-label="Status"><span class="pill ${statusKind(row.status)}">${esc(titleCase(row.status))}</span></td><td data-label="Actions"><a class="button secondary btn-sm" href="/admin/users/${esc(row.customer_id)}?tab=billing">Open billing</a></td></tr>`}).join('')}</tbody></table></div>`;
}
function pagination(data,filters,raw,displayRange){
 if(data.pages<=1)return'';const paramsBase=new URLSearchParams();paramsBase.set('range',displayRange);if(raw.from)paramsBase.set('from',raw.from);if(raw.to)paramsBase.set('to',raw.to);if(filters.q)paramsBase.set('orderQ',filters.q);if(filters.status)paramsBase.set('orderStatus',filters.status);if(filters.provider)paramsBase.set('orderProvider',filters.provider);if(filters.planId)paramsBase.set('orderPlan',filters.planId);if(filters.from)paramsBase.set('orderFrom',filters.from);if(filters.to)paramsBase.set('orderTo',filters.to);
 const href=p=>{const q=new URLSearchParams(paramsBase);q.set('page',p);return`${ORDERS_PATH}?${q}`;};
 const start=Math.max(1,data.page-2),end=Math.min(data.pages,data.page+2),nums=[];for(let p=start;p<=end;p++)nums.push(p===data.page?`<span class="ordersPage active">${p}</span>`:`<a class="ordersPage" href="${esc(href(p))}">${p}</a>`);
 return `<nav class="ordersPagination" aria-label="Purchase pages"><a class="ordersPage ${data.page<=1?'disabled':''}" ${data.page>1?`href="${esc(href(data.page-1))}"`:'aria-disabled="true"'}>← Previous</a>${nums.join('')}<a class="ordersPage ${data.page>=data.pages?'disabled':''}" ${data.page<data.pages?`href="${esc(href(data.page+1))}"`:'aria-disabled="true"'}>Next →</a></nav>`;
}
function purchasesSection(data,filters,plans,raw,displayRange){const first=data.total?(data.page-1)*PAGE_SIZE+1:0,last=Math.min(data.total,data.page*PAGE_SIZE);return `<section class="ordersPurchases"><div class="ordersSectionHead"><div><h2>Recent purchases</h2><p>Newest Stripe and PayPal purchases. Select a customer to continue in their Billing journey.</p></div><div><span>${number(data.total)} transactions</span><span class="ordersPerPage">10 per page</span></div></div>${purchaseFilterForm(filters,plans,raw,displayRange)}${orderTable(data)}<div class="ordersTableFooter"><span>Showing ${first}–${last} of ${number(data.total)} transactions</span>${pagination(data,filters,raw,displayRange)}</div></section>`;}
function expiryDisclosure(rows){return `<details class="ordersDisclosure"><summary><div><strong>▣ Upcoming expires</strong><span class="ordersBadge bad">${rows.length}</span><small>Customers with trial, cancelled-renewal or non-recurring access ending in the next 30 days</small></div><span>⌄</span></summary><div class="ordersDisclosureBody">${rows.length?`<div class="tableWrap"><table class="dataTable"><thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>Expires</th></tr></thead><tbody>${rows.map(row=>`<tr><td><a href="/admin/users/${esc(row.customer_id)}?tab=billing">${esc(row.customer)}</a></td><td>${esc(row.plan_name||'Plan')}</td><td><span class="pill ${statusKind(row.status)}">${esc(titleCase(row.status))}</span></td><td>${esc(day(row.current_period_end))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No upcoming expiries.</div>'}</div></details>`;}
function policyDisclosure(data){const p=data.policy||{};return `<details class="ordersDisclosure"><summary><div><strong>▣ Commercial policies and detailed payment state</strong><span class="ordersBadge bad">3</span><small>Configure trials, free access, downgrade behaviour and payment operations</small></div><span>⌄</span></summary><div class="ordersDisclosureBody"><div class="ordersPolicyGrid"><div><span>Trial eligibility</span><strong>${esc(titleCase(p.trialMode||'once_ever'))}</strong></div><div><span>Free-plan claims</span><strong>${esc(titleCase(p.freeMode||'once_per_plan'))}</strong></div><div><span>Paid → free downgrade</span><strong>${p.downgradeToFree?'Enabled':'Disabled'}</strong></div></div><div class="buttonRow"><a class="button secondary" href="/admin/plans/access-rules">Plan access rules</a><a class="button secondary" href="/admin/billing">Billing operations</a><a class="button secondary" href="/admin/payments">Payment providers</a></div></div></details>`;}
function resolvedDisclosure(allIncidents){const rows=allIncidents.filter(row=>row.resolved_at).slice(0,50);return `<details class="ordersDisclosure"><summary><div><strong>▣ Resolved payment history</strong><small>Previously resolved and recovered payment incidents</small></div><span>⌄</span></summary><div class="ordersDisclosureBody">${rows.length?`<div class="tableWrap"><table class="dataTable"><thead><tr><th>Resolved</th><th>Customer</th><th>Provider</th><th>Issue</th><th>Resolution</th></tr></thead><tbody>${rows.map(row=>`<tr><td>${esc(when(row.resolved_at))}</td><td>${row.customer_id?`<a href="/admin/users/${esc(row.customer_id)}?tab=billing">${esc(row.customer_name||'Customer')}</a>`:'Unresolved identity'}</td><td>${esc(titleCase(row.provider))}</td><td>${esc(titleCase(row.incident_type))}</td><td>${esc(row.resolution_note||'Resolved')}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No resolved payment incidents yet.</div>'}</div></details>`;}

async function page(req){
 await runtimeSettings.ensureLoaded();
 const transformed=await analyticsQuery(req.query||{}),analyticsReq={query:transformed},ctx=await commerceDashboard.buildContext(analyticsReq),displayRange=transformed.displayRange||transformed.range;
 const filters=parsePurchaseFilters(req.query||{},ctx.range);
 const [purchaseData,plans,breakdowns,overdue,profit,renewals,expires,allIncidents,policyData]=await Promise.all([purchases(filters),planOptions(),periodBreakdowns(ctx.range),overdueRevenue(ctx.reporting),profitability.profitSummary(ctx.range.start,ctx.range.end,ctx.reporting),renewalRows(),expiryRows(),incidents.recent(250),commercialPolicies.accessData()]);
 const body=`<link rel="stylesheet" href="/css/admin-orders-unified.css"><div class="ordersHeroLine"><div><h1 class="srOnly">Orders</h1><p>Order activity, billing health, and payment operations — all in one place.</p><div class="buttonRow"><a class="button secondary" href="/admin/billing#billing-problems">Review first past-due customer</a><a class="button secondary" href="/admin/billing">Billing operations</a></div></div>${rangeControl(displayRange,ctx.range)}</div>${incidentPanel(allIncidents)}${kpis(ctx,overdue,profit)}${analyticsGrid(ctx,breakdowns)}${renewalStrip(renewals,ctx.reporting)}${purchasesSection(purchaseData,filters,plans,req.query||{},displayRange)}<div class="ordersDisclosures">${expiryDisclosure(expires)}${policyDisclosure(policyData)}${resolvedDisclosure(allIncidents)}</div><script src="/js/admin-orders-unified.js" defer></script>`;
 return layout({siteName:runtimeSettings.siteName(),active:'orders',title:'Orders',subtitle:'Order activity, billing health, and payment operations — all in one place.',body,pageClass:'page-commerce-orders'});
}
async function rows(){return(await query(`SELECT s.id,s.customer_id,s.status,s.source,s.created_at,COALESCE(NULLIF(s.plan_name_snapshot,''),p.name) plan_name,COALESCE(NULLIF(s.plan_code_snapshot,''),p.code) plan_code,c.display_name,COALESCE(NULLIF(c.email,''),NULLIF(u.email,'')) customer_email,u.username customer_username FROM subscriptions s JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id LEFT JOIN plans p ON p.id=s.plan_id WHERE s.source IN ('stripe','paypal') ORDER BY s.created_at DESC LIMIT 500`)).rows;}
function ordersHero(orders){const recentCutoff=Date.now()-30*86400000,recent=(orders||[]).filter(row=>new Date(row.created_at).getTime()>=recentCutoff),attention=(orders||[]).filter(row=>row.status==='past_due');return `<div class="operatorCallout ${attention.length?'warn':'good'}"><strong>${attention.length?`${attention.length} purchased subscription(s) need billing attention`:`${recent.length} provider purchase(s) in the last 30 days`}</strong></div>`;}
async function markOrdersSeen(req){try{return await readCursors.markSeen(req.session.authUserId,'orders');}catch(error){console.warn('Order read cursor update failed:',error.message);return null;}}
function createAdminOrdersRouter(){const router=express.Router();router.use('/admin/commerce/orders',gate,noStore);router.use('/admin/orders',gate,noStore);router.get('/admin/commerce/orders',async(req,res,next)=>{try{const html=await page(req);await markOrdersSeen(req);return res.send(html);}catch(error){next(error);}});router.get('/admin/orders',(_req,res)=>res.redirect(308,ORDERS_PATH));return router;}
module.exports={createAdminOrdersRouter,page,rows,orderTable,ordersHero,markOrdersSeen,ORDERS_PATH,LEGACY_ORDERS_PATH,analyticsQuery,parsePurchaseFilters,purchases,periodBreakdowns};
