'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const lifecycle=require('../payments/lifecycle');
const incidents=require('../payments/incidents');
const runtimeSettings=require('./runtime-settings');
const {layout,esc}=require('./admin-html');
const graphics=require('./admin-section-graphics');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`}
function dt(v){return v?new Date(v).toLocaleString('en-GB'):'—'}
function money(minor,currency){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP').trim(),minimumFractionDigits:2}).format(Number(minor||0)/100)}catch{return `${currency} ${(Number(minor||0)/100).toFixed(2)}`}}
function multi(rows,multiplier=1){return rows.length?rows.map(r=>money(Number(r.amount_minor||0)*multiplier,r.currency)).join(' + '):'—'}

async function commerceData(){
  const [direct,states,events,activations,affiliateBalances,affiliateActivity,affiliateCount,paymentIncidents,admins]=await Promise.all([
    query(`SELECT COALESCE(s.currency_snapshot,p.currency) currency,
      SUM(ROUND(COALESCE(s.price_minor_snapshot,p.price_minor)::numeric * CASE COALESCE(s.billing_interval_snapshot,p.billing_interval)
        WHEN 'month' THEN 1 WHEN '6_months' THEN 1.0/6 WHEN 'year' THEN 1.0/12
        ELSE 30.4375/GREATEST(COALESCE(s.duration_days_snapshot,p.duration_days,30),1) END))::bigint amount_minor,
      COUNT(*)::int subscriptions
      FROM subscriptions s JOIN plans p ON p.id=s.plan_id
      WHERE s.superseded_by IS NULL AND s.status IN('active','trialing') AND s.starts_at<=NOW() AND s.current_period_end>NOW()
        AND ((s.source='stripe' AND COALESCE(s.provider_subscription_id,'') LIKE 'sub\\_%' ESCAPE '\\') OR (s.source='paypal' AND COALESCE(s.provider_subscription_id,'') LIKE 'I-%'))
      GROUP BY 1 ORDER BY 1`),
    query(`SELECT status,COUNT(*)::int n FROM subscriptions WHERE source IN('stripe','paypal') AND provider_subscription_id IS NOT NULL GROUP BY status ORDER BY status`),
    query(`SELECT COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days' AND(event_type ILIKE '%refund%' OR event_type ILIKE '%refunded%'))::int refunds,
      COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days' AND(event_type ILIKE '%dispute%' OR event_type ILIKE '%chargeback%'))::int disputes,
      COUNT(*) FILTER(WHERE created_at>=NOW()-INTERVAL '30 days' AND processing_error IS NOT NULL)::int failed_events
      FROM payment_events`),
    query(`SELECT COUNT(*) FILTER(WHERE source IN('stripe','paypal','service_credit') AND created_at>=NOW()-INTERVAL '30 days')::int activations,
      COUNT(*) FILTER(WHERE source IN('stripe','paypal','service_credit') AND status IN('cancelled','expired') AND updated_at>=NOW()-INTERVAL '30 days')::int churn
      FROM subscriptions`),
    query(`SELECT currency,
      COALESCE(SUM(amount_minor) FILTER(WHERE state='available'),0)::bigint available_minor,
      COALESCE(SUM(amount_minor) FILTER(WHERE state='pending'),0)::bigint pending_minor
      FROM affiliate_credit_ledger GROUP BY currency ORDER BY currency`),
    query(`SELECT currency,
      COALESCE(SUM(amount_minor) FILTER(WHERE entry_type='referral_reward' AND created_at>=NOW()-INTERVAL '30 days'),0)::bigint earned_minor,
      ABS(COALESCE(SUM(amount_minor) FILTER(WHERE entry_type='redeemed' AND created_at>=NOW()-INTERVAL '30 days'),0))::bigint redeemed_minor
      FROM affiliate_credit_ledger GROUP BY currency ORDER BY currency`),
    query(`SELECT COUNT(*)::int n FROM affiliate_profiles WHERE active=TRUE`),
    incidents.recent(100),
    query(`SELECT id,username FROM app_users WHERE role='admin' AND active=TRUE ORDER BY username`)
  ]);
  const currentIncidents=paymentIncidents||[];
  return{direct:direct.rows,states:states.rows,events:events.rows[0]||{},activations:activations.rows[0]||{},affiliateBalances:affiliateBalances.rows,affiliateActivity:affiliateActivity.rows,affiliateCount:Number(affiliateCount.rows[0]?.n||0),paymentIncidents:currentIncidents,admins:admins.rows};
}

function accountLink(row){if(row.customer_id)return `<a href="/admin/users/${encodeURIComponent(row.customer_id)}?tab=billing">${esc(row.customer_name||'Customer')}</a>`;return 'Historical / unresolved'}
function incidentTable(req,rows,admins){
  if(!rows.length)return'<div class="empty">No customer payment incidents recorded yet.</div>';
  return `<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>When</th><th>Incident</th><th>Account</th><th>Amount</th><th>Workflow</th><th>Actions</th></tr></thead><tbody>${rows.map(row=>`<tr id="incident-${esc(row.id)}"><td>${esc(dt(row.created_at))}<div class="subText">${esc(row.provider)}</div></td><td><strong>${esc(row.incident_type)}</strong><div class="subText">${esc(row.incident_status)}</div>${row.provider_event_id?`<div class="subText">Event ${esc(row.provider_event_id)}</div>`:''}</td><td>${accountLink(row)}</td><td>${row.amount_minor==null?'—':esc(money(row.amount_minor,row.currency))}</td><td>${row.resolved_at?'<span class="pill good">Resolved</span>':row.acknowledged_at?'<span class="pill">Acknowledged</span>':'<span class="pill warn">New</span>'}<div class="subText">${esc(row.assigned_username||'Unassigned')}</div>${row.resolution_note?`<div class="subText">${esc(row.resolution_note)}</div>`:''}</td><td><div class="buttonRow">${row.provider_event_id?`<form method="post" action="/admin/commerce/reconciliation/${esc(row.id)}">${token(req)}<button class="button secondary btn-sm">Verify with provider</button></form>`:''}${!row.acknowledged_at?`<form method="post" action="/admin/commerce/incidents/${esc(row.id)}/ack">${token(req)}<button class="button secondary btn-sm">Acknowledge</button></form>`:''}${row.resolved_at?`<form method="post" action="/admin/commerce/incidents/${esc(row.id)}/reopen">${token(req)}<button class="button secondary btn-sm">Reopen</button></form>`:`<details><summary class="button secondary btn-sm">Resolve / note</summary><form class="formPanel" method="post" action="/admin/commerce/incidents/${esc(row.id)}/resolve">${token(req)}<textarea class="input" name="note" maxlength="4000" placeholder="Resolution note"></textarea><label class="checkRow"><input type="checkbox" name="restoreAccess" value="1"> Release this incident's payment-risk hold (provider evidence required)</label><button class="button btn-sm">Resolve</button></form></details>`}<form method="post" action="/admin/commerce/incidents/${esc(row.id)}/assign">${token(req)}<select class="input" name="assignedTo"><option value="">Unassigned</option>${admins.map(admin=>`<option value="${esc(admin.id)}" ${String(admin.id)===String(row.assigned_to)?'selected':''}>${esc(admin.username)}</option>`).join('')}</select><button class="button secondary btn-sm">Assign</button></form></div></td></tr>`).join('')}</tbody></table></div>`;
}

function creditRows(rows,key){return rows.map(row=>({currency:row.currency,amount_minor:Number(row[key]||0)})).filter(row=>row.amount_minor!==0)}
function commerceGraphics(d,{directCount,availableCredit,pendingCredit,earned30,redeemed30}){
  const openIncidents=d.paymentIncidents.filter(row=>!row.resolved_at).length,a=d.activations||{},e=d.events||{},stateRows=d.states.map(row=>({name:row.status,count:row.n}));
  return `${graphics.hero({title:'Commerce health',subtitle:'Recurring revenue, payment incident pressure, affiliate service credit and customer lifecycle movement.',tone:openIncidents?'warn':'good',stats:[
    graphics.stat({label:'Direct MRR',value:esc(multi(d.direct)),meta:`${graphics.number(directCount)} recurring customer(s)`,tone:'good'}),
    graphics.stat({label:'Direct ARR',value:esc(multi(d.direct,12)),meta:'monthly equivalent x 12',tone:'blue'}),
    graphics.stat({label:'Open incidents',value:graphics.number(openIncidents),meta:'payment workflow items',tone:openIncidents?'warn':'good',href:'/admin/commerce#payment-incidents'}),
    graphics.stat({label:'Failed events',value:graphics.number(e.failed_events||0),meta:'provider events in 30 days',tone:Number(e.failed_events||0)?'warn':'good',href:'/admin/payments'})
  ],meters:[graphics.meter({label:'30-day activations vs churn',value:Number(a.activations||0),max:Math.max(Number(a.activations||0)+Number(a.churn||0),1),tone:Number(a.churn||0)>Number(a.activations||0)?'warn':'good',meta:`${graphics.number(a.activations||0)} activations / ${graphics.number(a.churn||0)} churn`})],actions:'<a class="button secondary" href="/admin/plans">Plans</a><a class="button secondary" href="/admin/payments">Payment providers</a><a class="button secondary" href="/admin/referrals">Affiliates</a>'})}${graphics.insightGrid([
    {title:'Provider states',subtitle:'Stripe and PayPal subscription statuses',value:graphics.number(d.states.reduce((sum,row)=>sum+Number(row.n||0),0)),body:graphics.bars(stateRows),tone:'blue',href:'/admin/billing',linkLabel:'Open billing'},
    {title:'Affiliate service credit',subtitle:'Available, pending, earned and redeemed',value:esc(multi(availableCredit)),body:graphics.bars([{name:'Available',count:availableCredit.reduce((sum,row)=>sum+row.amount_minor,0)},{name:'Pending',count:pendingCredit.reduce((sum,row)=>sum+row.amount_minor,0)},{name:'Earned 30d',count:earned30.reduce((sum,row)=>sum+row.amount_minor,0)},{name:'Redeemed 30d',count:redeemed30.reduce((sum,row)=>sum+row.amount_minor,0)}]),tone:'violet',href:'/admin/referrals',linkLabel:'Open affiliates'},
    {title:'Risk signals',subtitle:'Refunds, disputes and processing failures in 30 days',value:graphics.number(Number(e.refunds||0)+Number(e.disputes||0)+Number(e.failed_events||0)),body:graphics.bars([{name:'Refunds',count:e.refunds||0},{name:'Disputes',count:e.disputes||0},{name:'Failed events',count:e.failed_events||0}]),tone:Number(e.disputes||0)||openIncidents?'warn':'good',href:'/admin/payments/risk-policy',linkLabel:'Open risk policy'}
  ])}`;
}
async function page(req){
  await runtimeSettings.ensureLoaded();
  const d=await commerceData(),directCount=d.direct.reduce((sum,row)=>sum+Number(row.subscriptions||0),0),a=d.activations;
  const availableCredit=creditRows(d.affiliateBalances,'available_minor'),pendingCredit=creditRows(d.affiliateBalances,'pending_minor'),earned30=creditRows(d.affiliateActivity,'earned_minor'),redeemed30=creditRows(d.affiliateActivity,'redeemed_minor');
  const body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<div class="statusBanner"><strong>Revenue boundary:</strong> CAPTAiNFiN revenue reporting covers direct customer subscriptions. Affiliate service credit is shown separately because it is an account benefit, not cash revenue. Annual and six-month plans are normalized to monthly equivalents and currencies remain separate.</div>${commerceGraphics(d,{directCount,availableCredit,pendingCredit,earned30,redeemed30})}<section class="section"><div class="sectionHead"><h2>30-day lifecycle</h2></div><div class="metrics"><div class="metric"><div class="metricLabel">Customer activations</div><div class="metricValue">${esc(a.activations||0)}</div></div><div class="metric"><div class="metricLabel">Customer churn</div><div class="metricValue">${esc(a.churn||0)}</div></div><div class="metric"><div class="metricLabel">Affiliate credit earned</div><div class="metricValue">${esc(multi(earned30))}</div></div><div class="metric"><div class="metricLabel">Affiliate credit redeemed</div><div class="metricValue">${esc(multi(redeemed30))}</div></div></div></section><section class="section"><div class="sectionHead"><div><h2>Commercial policies</h2><div class="muted">Configuration lives with the product area it controls rather than on this reporting overview.</div></div></div><div class="quick-actions"><a class="quick-action" href="/admin/plans/access-rules"><strong>Trial & free access rules</strong><span>Who may claim free/trial access and paid-to-free behaviour</span></a><a class="quick-action" href="/admin/payments/risk-policy"><strong>Payment risk policy</strong><span>Refund, dispute and chargeback access behaviour</span></a></div></section><section class="section" id="payment-incidents"><div class="sectionHead"><h2>Payment incidents</h2><span class="muted">Provider verification, assignment and conservative access recovery</span></div>${incidentTable(req,d.paymentIncidents,d.admins)}</section><section class="section"><div class="sectionHead"><h2>Provider subscription states</h2></div>${d.states.length?`<div class="tableWrap"><table class="dataTable responsiveTable"><thead><tr><th>Status</th><th>Count</th></tr></thead><tbody>${d.states.map(row=>`<tr><td>${esc(row.status)}</td><td>${esc(row.n)}</td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No provider subscriptions.</div>'}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'commerce-overview',title:'Commerce',subtitle:'Revenue, lifecycle, affiliate service credit and payment incidents',body});
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
