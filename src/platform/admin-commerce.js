'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const lifecycle=require('../payments/lifecycle');
const incidents=require('../payments/incidents');
const runtimeSettings=require('./runtime-settings');
const {layout,esc}=require('./admin-html');
const {buildContext:commerceDashboardContext}=require('./admin-commerce-dashboard');
const {renderWidgetGrid}=require('./admin-dashboard-page');
const {rangeControls}=require('./admin-dashboard-view');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`}
function dt(v){return v?new Date(v).toLocaleString('en-GB'):'—'}
function money(minor,currency){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP').trim(),minimumFractionDigits:2}).format(Number(minor||0)/100)}catch{return `${currency} ${(Number(minor||0)/100).toFixed(2)}`}}
function multi(rows,multiplier=1){return rows.length?rows.map(r=>money(Number(r.amount_minor||0)*multiplier,r.currency)).join(' + '):'—'}

async function commerceData(){
  const [states,events,activations,upcomingExpiries,affiliateBalances,affiliateActivity,affiliateCount,affiliateSettings,paymentIncidents,admins]=await Promise.all([
    query(`SELECT status,COUNT(*)::int n FROM subscriptions WHERE source IN('stripe','paypal') AND provider_subscription_id IS NOT NULL GROUP BY status ORDER BY status`),
    query(`SELECT COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days' AND(event_type ILIKE '%refund%' OR event_type ILIKE '%refunded%'))::int refunds,
      COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days' AND(event_type ILIKE '%dispute%' OR event_type ILIKE '%chargeback%'))::int disputes,
      COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days' AND processing_error IS NOT NULL)::int failed_events
      FROM payment_events`),
    query(`SELECT COUNT(*) FILTER(WHERE source IN('stripe','paypal','service_credit') AND created_at>=NOW()-INTERVAL '30 days')::int activations,
      COUNT(*) FILTER(WHERE source IN('stripe','paypal','service_credit') AND status IN('cancelled','expired') AND updated_at>=NOW()-INTERVAL '30 days')::int churn
      FROM subscriptions`),
    query(`SELECT s.id,s.customer_id,s.status,s.source,s.cancel_at_period_end,s.current_period_end,p.name plan_name,COALESCE(c.display_name,u.username,c.email,'Customer') customer_name
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id JOIN customers c ON c.id=s.customer_id LEFT JOIN app_users u ON u.id=c.user_id
      WHERE s.superseded_by IS NULL AND s.current_period_end>NOW() AND s.current_period_end<=NOW()+INTERVAL '30 days'
        AND (s.cancel_at_period_end=TRUE OR s.status IN('trialing','past_due','paused') OR COALESCE(s.provider_subscription_id,'')='')
      ORDER BY s.current_period_end ASC LIMIT 25`),
    query(`SELECT currency,
      COALESCE(SUM(amount_minor) FILTER(WHERE state='available'),0)::bigint available_minor,
      COALESCE(SUM(amount_minor) FILTER(WHERE state='pending'),0)::bigint pending_minor
      FROM affiliate_credit_ledger GROUP BY currency ORDER BY currency`),
    query(`SELECT currency,
      COALESCE(SUM(amount_minor) FILTER(WHERE entry_type='referral_reward' AND created_at>=NOW()-INTERVAL '30 days'),0)::bigint earned_minor,
      ABS(COALESCE(SUM(amount_minor) FILTER(WHERE entry_type='redeemed' AND created_at>=NOW()-INTERVAL '30 days'),0))::bigint redeemed_minor
      FROM affiliate_credit_ledger GROUP BY currency ORDER BY currency`),
    query(`SELECT COUNT(*)::int n FROM affiliate_profiles WHERE active=TRUE`),
    query(`SELECT setting_value FROM platform_settings WHERE setting_key='affiliate_program'`),
    incidents.recent(100),
    query(`SELECT id,username FROM app_users WHERE role='admin' AND active=TRUE ORDER BY username`)
  ]);
  const currentIncidents=paymentIncidents||[];
  const affiliateProgram=affiliateSettings.rows[0]?.setting_value||{};
  return{states:states.rows,events:events.rows[0]||{},activations:activations.rows[0]||{},upcomingExpiries:upcomingExpiries.rows,affiliateBalances:affiliateBalances.rows,affiliateActivity:affiliateActivity.rows,affiliateCount:Number(affiliateCount.rows[0]?.n||0),affiliateEnabled:affiliateProgram.enabled===true,paymentIncidents:currentIncidents,admins:admins.rows};
}

function accountLink(row){if(row.customer_id)return `<a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing">${esc(row.customer_name||'Customer')}</a>`;return 'Historical / unresolved'}
function incidentTable(req,rows,admins){
  if(!rows.length)return'<div class="empty">No customer payment incidents recorded yet.</div>';
  return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>When</th><th>Incident</th><th>Account</th><th>Amount</th><th>Workflow</th><th>Actions</th></tr></thead><tbody>${rows.map(row=>`<tr id="incident-${esc(row.id)}"><td>${esc(dt(row.created_at))}<div class="subText">${esc(row.provider)}</div></td><td><strong>${esc(row.incident_type)}</strong><div class="subText">${esc(row.incident_status)}</div>${row.provider_event_id?`<div class="subText">Event ${esc(row.provider_event_id)}</div>`:''}</td><td>${accountLink(row)}</td><td>${row.amount_minor==null?'—':esc(money(row.amount_minor,row.currency))}</td><td>${row.resolved_at?'<span class="pill good">Resolved</span>':row.acknowledged_at?'<span class="pill">Acknowledged</span>':'<span class="pill warn">New</span>'}<div class="subText">${esc(row.assigned_username||'Unassigned')}</div>${row.resolution_note?`<div class="subText">${esc(row.resolution_note)}</div>`:''}</td><td><div class="buttonRow">${row.provider_event_id?`<form method="post" action="/admin/commerce/reconciliation/${esc(row.id)}">${token(req)}<button class="button secondary btn-sm">Verify with provider</button></form>`:''}${!row.acknowledged_at?`<form method="post" action="/admin/commerce/incidents/${esc(row.id)}/ack">${token(req)}<button class="button secondary btn-sm">Acknowledge</button></form>`:''}${row.resolved_at?`<form method="post" action="/admin/commerce/incidents/${esc(row.id)}/reopen">${token(req)}<button class="button secondary btn-sm">Reopen</button></form>`:`<details><summary class="button secondary btn-sm">Resolve / note</summary><form class="formPanel" method="post" action="/admin/commerce/incidents/${esc(row.id)}/resolve">${token(req)}<textarea class="input" name="note" maxlength="4000" placeholder="Resolution note"></textarea><label class="checkRow"><input type="checkbox" name="restoreAccess" value="1"> Release this incident's payment-risk hold (provider evidence required)</label><button class="button btn-sm">Resolve</button></form></details>`}<form method="post" action="/admin/commerce/incidents/${esc(row.id)}/assign">${token(req)}<select class="input" name="assignedTo"><option value="">Unassigned</option>${admins.map(admin=>`<option value="${esc(admin.id)}" ${String(admin.id)===String(row.assigned_to)?'selected':''}>${esc(admin.username)}</option>`).join('')}</select><button class="button secondary btn-sm">Assign</button></form></div></td></tr>`).join('')}</tbody></table></div>`;
}

function creditRows(rows,key){return rows.map(row=>({currency:row.currency,amount_minor:Number(row[key]||0)})).filter(row=>row.amount_minor!==0)}
function paymentOperationsSplit(d){
  const openIncidents=d.paymentIncidents.filter(row=>!row.resolved_at).length;
  const failedEvents=Number(d.events?.failed_events||0);
  return `<section class="section"><div class="sectionHead"><div><h2>Payment operations</h2><div class="muted">Commerce shows customer-impacting payment work. Provider setup stays on the Payments page.</div></div></div><div class="quick-actions"><a class="quick-action" href="/admin/payments#provider-setup"><strong>Provider setup</strong><span>Stripe, PayPal, webhooks, credentials and connection tests.</span></a><a class="quick-action" href="#payment-incidents"><strong>Operational payment problems</strong><span>${esc(openIncidents)} open incident${openIncidents===1?'':'s'} and ${esc(failedEvents)} failed provider event${failedEvents===1?'':'s'} in the last 30 days.</span></a><a class="quick-action" href="/admin/payments#payment-operations"><strong>Provider event monitor</strong><span>Recent webhook events and local subscription-state counts.</span></a></div></section>`;
}
async function page(req){
  await runtimeSettings.ensureLoaded();
  const d=await commerceData(),a=d.activations;
  const dashboardCtx=await commerceDashboardContext(req);
  const widgetGrid=await renderWidgetGrid('commerce',req,dashboardCtx);
  const earned30=creditRows(d.affiliateActivity,'earned_minor'),redeemed30=creditRows(d.affiliateActivity,'redeemed_minor');
  const expiryRows=(d.upcomingExpiries||[]).length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Plan</th><th>Status</th><th>Access ends</th></tr></thead><tbody>${d.upcomingExpiries.map(row=>`<tr><td><a href="/admin/users/${esc(row.customer_id)}?tab=billing">${esc(row.customer_name)}</a></td><td>${esc(row.plan_name)}</td><td><span class="pill ${row.cancel_at_period_end?'warn':''}">${esc(row.cancel_at_period_end?'renewal stopping':row.status)}</span><div class="subText">${esc(row.source)}</div></td><td>${esc(dt(row.current_period_end))}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No upcoming customer expiries in the next 30 days.</div>';
  const affiliateMetrics=d.affiliateEnabled?`<div class="metric"><div class="metricLabel">Affiliate credit earned</div><div class="metricValue">${esc(multi(earned30))}</div></div><div class="metric"><div class="metricLabel">Affiliate credit redeemed</div><div class="metricValue">${esc(multi(redeemed30))}</div></div>`:'';
  const affiliateBoundary=d.affiliateEnabled?' Affiliate service credit is shown separately because it is an account benefit, not cash revenue.':' Optional affiliate service credit is hidden until the affiliate programme is enabled.';
  const body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<div class="statusBanner"><strong>Revenue boundary:</strong> CAPTAiNFiN revenue reporting covers direct customer subscriptions.${affiliateBoundary} Annual and six-month plans are normalized to monthly equivalents and currencies remain separate.</div>${rangeControls(dashboardCtx.range)}${widgetGrid}<section class="section"><div class="sectionHead"><h2>30-day lifecycle</h2></div><div class="metrics"><div class="metric"><div class="metricLabel">New subscribers</div><div class="metricValue">${esc(a.activations||0)}</div></div><div class="metric"><div class="metricLabel">Upcoming expiries</div><div class="metricValue">${esc((d.upcomingExpiries||[]).length)}</div></div><div class="metric"><div class="metricLabel">Customer churn</div><div class="metricValue">${esc(a.churn||0)}</div></div>${affiliateMetrics}</div></section><section class="section"><div class="sectionHead"><div><h2>Upcoming expiries</h2><div class="muted">Customers whose access may end in the next 30 days because renewal is stopping, payment is risky or the access is non-recurring.</div></div></div>${expiryRows}</section><section class="section"><div class="sectionHead"><div><h2>Commercial policies</h2><div class="muted">Configuration lives with the product area it controls rather than on this reporting overview.</div></div></div><div class="quick-actions"><a class="quick-action" href="/admin/plans/access-rules"><strong>Trial & free access rules</strong><span>Who may claim free/trial access and paid-to-free behaviour</span></a><a class="quick-action" href="/admin/payments/risk-policy"><strong>Payment risk policy</strong><span>Refund, dispute and chargeback access behaviour</span></a>${d.affiliateEnabled?'<a class="quick-action" href="/admin/referrals"><strong>Affiliate programme</strong><span>Referral attribution, service-credit balances and reward qualification</span></a>':''}</div></section>${paymentOperationsSplit(d)}<section class="section" id="payment-incidents"><div class="sectionHead"><h2>Payment incidents</h2><span class="muted">Provider verification, assignment and conservative access recovery</span></div>${incidentTable(req,d.paymentIncidents,d.admins)}</section><section class="section"><div class="sectionHead"><h2>Provider subscription states</h2></div>${d.states.length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${d.states.map(row=>`<tr><td>${esc(row.status)}</td><td>${esc(row.n)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No provider subscriptions.</div>'}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'commerce-overview',title:'Plans & Payments',subtitle:d.affiliateEnabled?'Revenue, lifecycle, affiliate service credit and payment incidents':'Revenue, subscriber movement, upcoming expiries and payment incidents',body});
}

function createAdminCommerceRouter(){
  const r=express.Router();r.use('/admin/commerce',gate,noStore);
  r.get('/admin/commerce',async(req,res,next)=>{try{return res.send(await page(req))}catch(error){next(error)}});
  r.post('/admin/commerce/policy',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await lifecycle.saveTrialPolicy({trialMode:req.body.trialMode,freeMode:req.body.freeMode,paidCanClaimFree:req.body.paidCanClaimFree==='1',downgradeToFree:req.body.downgradeToFree==='1',downgradeFreePlanCode:req.body.downgradeFreePlanCode},req.session.authUserId);return res.redirect('/admin/plans/access-rules?message='+encodeURIComponent('Trial and free-access rules saved.'))}catch(error){return res.redirect('/admin/plans/access-rules?error='+encodeURIComponent(error.message))}});
  r.post('/admin/commerce/risk-policy',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await incidents.savePolicy(req.body,req.session.authUserId);return res.redirect('/admin/payments/risk-policy?message='+encodeURIComponent('Payment-risk policy saved.'))}catch(error){return res.redirect('/admin/payments/risk-policy?error='+encodeURIComponent(error.message))}});
  r.post('/admin/commerce/incidents/:id/ack',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await incidents.acknowledge(req.params.id,req.session.authUserId);return res.redirect('/admin/commerce?message='+encodeURIComponent('Incident acknowledged.'))}catch(error){return res.redirect('/admin/commerce?error='+encodeURIComponent(error.message))}});
  r.post('/admin/commerce/incidents/:id/assign',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await incidents.assign(req.params.id,req.body.assignedTo||null,req.session.authUserId);return res.redirect('/admin/commerce?message='+encodeURIComponent('Incident assignment updated.'))}catch(error){return res.redirect('/admin/commerce?error='+encodeURIComponent(error.message))}});
  r.post('/admin/commerce/incidents/:id/resolve',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await incidents.resolve(req.params.id,{note:req.body.note,restoreAccess:req.body.restoreAccess==='1'},req.session.authUserId);return res.redirect('/admin/commerce?message='+encodeURIComponent('Incident resolved.'))}catch(error){return res.redirect('/admin/commerce?error='+encodeURIComponent(error.message))}});
  r.post('/admin/commerce/incidents/:id/reopen',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{await incidents.reopen(req.params.id,req.session.authUserId);return res.redirect('/admin/commerce?message='+encodeURIComponent('Incident reopened.'))}catch(error){return res.redirect('/admin/commerce?error='+encodeURIComponent(error.message))}});
  return r;
}

module.exports={createAdminCommerceRouter,commerceData,incidentTable,page};
