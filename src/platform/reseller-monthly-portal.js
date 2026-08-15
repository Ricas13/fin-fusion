'use strict';

const crypto = require('crypto');
const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const auth = require('../auth/service');
const provisioning = require('../jellyfin/provisioning');
const providerSettings = require('../payments/provider-settings');
const stripe = require('../payments/stripe');
const paypal = require('../payments/paypal');
const resellerBilling = require('../payments/reseller-billing');
const monthly = require('../resellers/monthly');
const branding = require('./branding');
const { esc } = require('./admin-html');

const PERIODS = new Map([
    ['7d', { days: 7, label: '7 days' }],
    ['30d', { days: 30, label: '30 days' }],
    ['90d', { days: 90, label: '90 days' }],
    ['365d', { days: 365, label: '12 months' }]
]);

function site(){ return process.env.SITE_NAME || 'CAPTaINFiN'; }
function gate(req,res,next){ if(req.session?.authUserId&&req.session?.authRole==='reseller') return next(); return res.redirect('/login?session=expired'); }
function noStore(_req,res,next){ res.setHeader('Cache-Control','no-store, private, max-age=0'); res.setHeader('Pragma','no-cache'); next(); }
function token(req){ return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function notice(req){ return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`; }
function randomPassword(){ return `${crypto.randomBytes(14).toString('base64url')}A1!`; }
function money(minor,currency='GBP'){
    try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP').trim(),minimumFractionDigits:2}).format(Number(minor||0)/100);}
    catch{return `${currency} ${(Number(minor||0)/100).toFixed(2)}`;}
}
function date(value){ return value?new Date(value).toLocaleDateString('en-GB',{day:'numeric',month:'short',year:'numeric'}):'—'; }
function redirect(res,key,msg){ return res.redirect(`/reseller?${key}=${encodeURIComponent(msg)}`); }
function absoluteUrl(req,path){ const proto=req.get('x-forwarded-proto')?.split(',')[0]?.trim()||req.protocol; const host=req.get('x-forwarded-host')||req.get('host'); return `${proto}://${host}${path}`; }

async function resolveReseller(userId){
    const result=await query(`SELECT r.*,u.username,u.email,u.active FROM resellers r JOIN app_users u ON u.id=r.user_id WHERE r.user_id=$1`,[userId]);
    if(!result.rowCount) throw new Error('This account is not linked to a reseller.');
    return result.rows[0];
}

function range(req){
    const key=PERIODS.has(String(req.query.range||''))?String(req.query.range):'30d';
    const p=PERIODS.get(key); const end=new Date(); const start=new Date(end.getTime()-p.days*86400000);
    return {key,label:p.label,start,end,days:p.days};
}

async function downstreamPlans(){
    const result=await query(`SELECT id,code,name,duration_days,price_minor,currency,streams,allow_downloads FROM plans WHERE active=TRUE AND audience IN ('reseller','both') ORDER BY sort_order,price_minor,name`);
    return result.rows;
}

async function analytics(resellerId,rng){
    const [sales,daily,newCustomers,playback,live,top]=await Promise.all([
        query(`SELECT currency,SUM(amount_minor)::bigint amount_minor,COUNT(*)::int sales FROM reseller_sales WHERE reseller_id=$1 AND created_at>=$2 AND created_at<$3 GROUP BY currency ORDER BY currency`,[resellerId,rng.start,rng.end]),
        query(`SELECT date_trunc('day',created_at)::date day,currency,SUM(amount_minor)::bigint amount_minor FROM reseller_sales WHERE reseller_id=$1 AND created_at>=$2 AND created_at<$3 GROUP BY 1,2 ORDER BY 1,2`,[resellerId,rng.start,rng.end]),
        query(`SELECT COUNT(*)::int n FROM customers WHERE reseller_id=$1 AND is_reseller_owner=FALSE AND created_at>=$2 AND created_at<$3`,[resellerId,rng.start,rng.end]),
        query(`SELECT COUNT(*)::int sessions,COUNT(DISTINCT ph.customer_id)::int viewers,COALESCE(SUM(GREATEST(0,EXTRACT(EPOCH FROM(COALESCE(ph.ended_at,ph.last_seen_at)-ph.started_at)))),0)::bigint seconds FROM playback_history ph JOIN customers c ON c.id=ph.customer_id WHERE c.reseller_id=$1 AND ph.started_at>=$2 AND ph.started_at<$3`,[resellerId,rng.start,rng.end]),
        query(`SELECT COUNT(DISTINCT aps.jellyfin_session_id)::int streams FROM active_playback_sessions aps JOIN customers c ON c.id=aps.customer_id WHERE c.reseller_id=$1`,[resellerId]),
        query(`SELECT c.id,c.display_name,COALESCE(SUM(s.amount_minor),0)::bigint revenue_minor,MAX(s.currency) currency,COUNT(s.id)::int sales FROM customers c LEFT JOIN reseller_sales s ON s.customer_id=c.id AND s.created_at>=$2 AND s.created_at<$3 WHERE c.reseller_id=$1 AND c.is_reseller_owner=FALSE GROUP BY c.id ORDER BY revenue_minor DESC,sales DESC,c.display_name LIMIT 8`,[resellerId,rng.start,rng.end])
    ]);
    const totals=sales.rows;
    const primary=totals.slice().sort((a,b)=>Number(b.amount_minor)-Number(a.amount_minor))[0]||{currency:'GBP',amount_minor:0,sales:0};
    const days=[]; for(let i=Math.min(rng.days,45)-1;i>=0;i--){const d=new Date(rng.end.getTime()-i*86400000);days.push({key:d.toISOString().slice(0,10),value:0});}
    const byDay=new Map(days.map(x=>[x.key,x]));
    for(const row of daily.rows){ if(String(row.currency).trim()!==String(primary.currency).trim()) continue; const point=byDay.get(new Date(row.day).toISOString().slice(0,10)); if(point) point.value+=Number(row.amount_minor||0); }
    return {totals,primary,newCustomers:Number(newCustomers.rows[0]?.n||0),playback:playback.rows[0]||{},liveStreams:Number(live.rows[0]?.streams||0),top:top.rows,series:days};
}

function sparkBars(series,currency){
    const max=Math.max(1,...series.map(x=>Number(x.value||0)));
    return `<div class="resellerChart">${series.map(x=>`<div class="resellerBarWrap" title="${esc(x.key)} · ${esc(money(x.value,currency))}"><div class="resellerBar" style="height:${Math.max(3,Math.round((Number(x.value||0)/max)*100))}%"></div></div>`).join('')}</div>`;
}

function shell({title='Reseller dashboard',subtitle='',body}){
    return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark"><title>${esc(title)} · ${esc(site())}</title><link rel="icon" href="${esc(branding.assetUrl('favicon'))}"><link rel="stylesheet" href="/css/admin-original-base.css"><link rel="stylesheet" href="/css/admin-original-components.css"><link rel="stylesheet" href="/css/customer-360.css"><style>
    body{background:#0c1117}.resellerShell{max-width:1500px;margin:auto;padding:0 22px 50px}.resellerTop{height:58px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #222933;margin-bottom:22px}.brand{display:flex;gap:10px;align-items:center;font-weight:800}.brand img{width:30px;height:30px;border-radius:7px;object-fit:cover}.resellerHeader{display:flex;justify-content:space-between;gap:18px;align-items:end;margin:8px 0 18px}.resellerHeader h1{font-size:24px;margin:0 0 4px}.rangeTabs{display:flex;gap:6px;flex-wrap:wrap}.rangeTabs a{padding:7px 10px;border:1px solid #29323d;border-radius:7px;color:#93a0b0;text-decoration:none}.rangeTabs a.active{color:#fff;border-color:#20a9d6;background:rgba(32,169,214,.12)}.resellerChart{height:180px;display:flex;gap:3px;align-items:end;border-bottom:1px solid #29323d;padding:16px 4px 0}.resellerBarWrap{height:100%;flex:1;display:flex;align-items:end}.resellerBar{width:100%;background:linear-gradient(180deg,#34bfe9,#197a9c);border-radius:4px 4px 0 0;min-height:3px}.seatMeter{height:8px;border-radius:20px;background:#222a34;overflow:hidden;margin-top:8px}.seatMeter span{display:block;height:100%;background:#20a9d6}.customerTable form{margin:0}.customerActions{display:flex;gap:6px;flex-wrap:wrap}.salesGrid{display:grid;grid-template-columns:minmax(0,2fr) minmax(280px,1fr);gap:16px}.tierCards{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:12px}.tierCard{border:1px solid #28313c;border-radius:12px;padding:17px;background:#111820}.tierPrice{font-size:27px;font-weight:850;color:#fff;margin:9px 0}.providerButtons{display:flex;gap:7px;flex-wrap:wrap}.ownerTag{color:#39bce7;font-size:10px;font-weight:800;text-transform:uppercase;letter-spacing:.08em}.dangerText{color:#ff8791}.credentialBox{padding:16px;border:1px solid #2c3947;background:#0d141c;border-radius:9px;font-family:ui-monospace,monospace;font-size:17px;word-break:break-all}@media(max-width:850px){.salesGrid{grid-template-columns:1fr}.resellerHeader{display:block}.rangeTabs{margin-top:12px}.resellerShell{padding:0 12px 35px}}
    </style></head><body><div class="resellerShell"><header class="resellerTop"><div class="brand"><img src="${esc(branding.assetUrl('logo'))}" alt=""><span>${esc(site())} · Reseller</span></div><div class="buttonRow"><a class="button secondary btn-sm" href="/reseller/credit-history">Legacy credits</a><a class="button secondary btn-sm" href="/logout">Sign out</a></div></header><div class="resellerHeader"><div><h1>${esc(title)}</h1><div class="muted">${esc(subtitle)}</div></div></div>${body}</div></body></html>`;
}

function tierChoices(req,tiers,current){
    if(!tiers.length) return '<div class="empty">No monthly reseller plans are currently available. Contact the administrator.</div>';
    return `<div class="tierCards">${tiers.map(t=>{const providers=Array.isArray(t.provider_prices)?t.provider_prices.filter(p=>p.active):[];const isCurrent=current&&String(current.tier_id)===String(t.id);return `<article class="tierCard"><div class="serverTop"><strong>${esc(t.name)}</strong>${isCurrent?'<span class="pill good">Current</span>':''}</div><div class="tierPrice">${esc(money(t.monthly_price_minor,t.currency))}<span class="muted" style="font-size:12px"> / month</span></div><p class="muted">${esc(t.description||`${t.seat_limit} active Jellyfin accounts.`)}</p><p><strong>${esc(t.seat_limit)}</strong> active accounts <span class="muted">including your own account</span></p>${!current?`<div class="providerButtons">${providers.some(p=>p.provider==='stripe')?`<form method="post" action="/reseller/billing/stripe">${token(req)}<input type="hidden" name="tierId" value="${esc(t.id)}"><button class="button">Subscribe with Stripe</button></form>`:''}${providers.some(p=>p.provider==='paypal')?`<form method="post" action="/reseller/billing/paypal">${token(req)}<input type="hidden" name="tierId" value="${esc(t.id)}"><button class="button secondary">Subscribe with PayPal</button></form>`:''}${!providers.length?'<span class="muted">Contact admin to subscribe</span>':''}</div>`:'<div class="muted">Tier changes are controlled by the administrator while a subscription is active.</div>'}</article>`;}).join('')}</div>`;
}

async function dashboard(req){
    const reseller=await resolveReseller(req.session.authUserId); const rng=range(req);
    await providerSettings.ensureLoaded().catch(()=>{});
    const [subscription,seats,customers,plans,tiers,stats]=await Promise.all([
        monthly.currentSubscription(reseller.id),monthly.seatUsage(reseller.id),monthly.listManagedCustomers(reseller.id),downstreamPlans(),monthly.listTiers({visibleOnly:true,activeOnly:true}),analytics(reseller.id,rng)
    ]);
    const entitled=Boolean(subscription&&subscription.status==='active'&&new Date(subscription.current_period_end)>new Date());
    const limit=Number(subscription?.seat_limit||0); const pct=limit?Math.min(100,Math.round((seats/limit)*100)):0;
    const owner=customers.find(c=>c.is_reseller_owner);
    const primary=stats.primary;
    const rangeTabs=[...PERIODS].map(([key,p])=>`<a class="${rng.key===key?'active':''}" href="/reseller?range=${key}">${p.label}</a>`).join('');
    const status=subscription?(entitled?'Active':String(subscription.status||'inactive')):'Not subscribed';
    const mrr=subscription?money(subscription.monthly_price_minor,subscription.currency):'—';
    const body=`${notice(req)}<div class="resellerHeader"><div><div class="muted">Selected reporting period</div><strong>${esc(rng.label)}</strong></div><div class="rangeTabs">${rangeTabs}</div></div>
        <div class="metrics">
            <div class="metric"><div class="metricLabel">Downstream revenue</div><div class="metricValue">${esc(money(primary.amount_minor,primary.currency))}</div><div class="subText">${esc(primary.sales||0)} recorded sale${Number(primary.sales)===1?'':'s'}</div></div>
            <div class="metric"><div class="metricLabel">Active accounts</div><div class="metricValue">${seats}${limit?` / ${limit}`:''}</div><div class="seatMeter"><span style="width:${pct}%"></span></div></div>
            <div class="metric"><div class="metricLabel">New customers</div><div class="metricValue">${esc(stats.newCustomers)}</div><div class="subText">${esc(rng.label)}</div></div>
            <div class="metric"><div class="metricLabel">Watch time</div><div class="metricValue">${(Number(stats.playback.seconds||0)/3600).toFixed(1)}h</div><div class="subText">${esc(stats.playback.sessions||0)} sessions</div></div>
            <div class="metric"><div class="metricLabel">Streams now</div><div class="metricValue">${esc(stats.liveStreams)}</div></div>
            <div class="metric"><div class="metricLabel">Your CAPTaINFiN bill</div><div class="metricValue">${esc(mrr)}</div><div class="subText">${esc(status)}${subscription?` · paid to ${esc(date(subscription.current_period_end))}`:''}</div></div>
        </div>
        ${!entitled?`<div class="notice error"><strong>Your reseller subscription is not active.</strong> Customer activation/renewal is locked. Once a previously-paid monthly subscription becomes past due or expires, CAPTaINFiN suspends the reseller estate until payment is restored.</div>`:''}
        <div class="salesGrid"><section class="section"><div class="sectionHead"><h2>Revenue</h2><span class="muted">Manual downstream sales recorded by you</span></div>${sparkBars(stats.series,primary.currency)}</section><section class="section"><div class="sectionHead"><h2>Top customers</h2></div>${stats.top.length?stats.top.map(c=>`<div class="serverTop" style="padding:8px 0;border-bottom:1px solid #222933"><span>${esc(c.display_name||'Customer')}</span><strong>${esc(money(c.revenue_minor,c.currency||primary.currency))}</strong></div>`).join(''):'<div class="empty">No sales in this period.</div>'}</section></div>
        <section class="section"><div class="sectionHead"><h2>Monthly reseller subscription</h2><span class="muted">Your whole estate depends on this recurring subscription</span></div>${tierChoices(req,tiers,subscription)}${subscription&&subscription.source!=='manual'&&!subscription.cancel_at_period_end?`<form class="formPanel" method="post" action="/reseller/billing/cancel">${token(req)}<button class="button secondary">Cancel renewal at period end</button><div class="inlineHelp">Access remains active until the paid-through date, then your estate is suspended.</div></form>`:''}</section>
        <section class="section"><div class="sectionHead"><h2>Your own Jellyfin account</h2><span class="muted">Counts as one active account in your reseller allowance</span></div>${owner?`<div class="serverCard"><strong>${esc(owner.jellyfin_username||owner.display_name||reseller.username)}</strong><div class="subText">${esc(owner.plan_name||'No active plan')} · ${esc(owner.server_name||'Provisioning pending')}</div></div>`:entitled&&plans.length?`<form class="formPanel" method="post" action="/reseller/owner/create">${token(req)}<div class="formGrid"><div class="formGroup"><label>Customer access plan</label><select class="input" name="planCode">${plans.map(p=>`<option value="${esc(p.code)}">${esc(p.name)} · ${esc(p.duration_days)} days</option>`).join('')}</select></div></div><button class="button">Create my Jellyfin account</button></form>`:'<div class="empty">Activate a monthly reseller subscription before creating your own Jellyfin access.</div>'}</section>
        <section class="section"><div class="sectionHead"><h2>Add customer</h2><span class="muted">You decide the sale; CAPTaINFiN handles Jellyfin provisioning</span></div>${entitled&&plans.length&&seats<limit?`<form class="formPanel" method="post" action="/reseller/customer/create">${token(req)}<div class="formGrid"><div class="formGroup"><label>Jellyfin username</label><input class="input" name="username" required pattern="[A-Za-z0-9._-]{3,40}"></div><div class="formGroup"><label>Customer plan</label><select class="input" name="planCode">${plans.map(p=>`<option value="${esc(p.code)}">${esc(p.name)} · ${esc(p.duration_days)} days</option>`).join('')}</select></div><div class="formGroup"><label>Amount you charged</label><input class="input" type="number" name="amount" step="0.01" min="0" value="0.00"></div><div class="formGroup"><label>Currency</label><input class="input" name="currency" maxlength="3" value="${esc(subscription?.currency||'GBP')}"></div><div class="formGroup"><label>Payment method</label><select class="input" name="paymentMethod"><option>Cash</option><option>Bank transfer</option><option>PayPal</option><option>Stripe</option><option>Other</option></select></div><div class="formGroup"><label>Note</label><input class="input" name="note" maxlength="500"></div></div><button class="button">Create customer & provision Jellyfin</button></form>`:!entitled?'<div class="empty">Your monthly reseller subscription must be active first.</div>':`<div class="notice error">Your ${esc(subscription?.tier_name||'reseller')} tier is full (${seats}/${limit}). Upgrade the reseller tier before adding another active account.</div>`}</section>
        <section class="section"><div class="sectionHead"><h2>Customers</h2><span class="muted">${customers.length} managed record${customers.length===1?'':'s'}</span></div>${customers.length?`<div class="tableWrap customerTable"><table class="dataTable responsiveTable"><thead><tr><th>Customer</th><th>Plan</th><th>Server</th><th>Access until</th><th>Streams</th><th>Status</th><th></th></tr></thead><tbody>${customers.map(c=>`<tr><td data-label="Customer"><strong>${esc(c.display_name||c.jellyfin_username||'Customer')}</strong>${c.is_reseller_owner?'<div class="ownerTag">Your account</div>':`<div class="subText">${esc(c.jellyfin_username||'Provisioning pending')}</div>`}</td><td data-label="Plan">${esc(c.plan_name||'—')}</td><td data-label="Server">${esc(c.server_name||'—')}</td><td data-label="Access until">${esc(date(c.current_period_end))}</td><td data-label="Streams">${esc(c.active_streams||0)}</td><td data-label="Status"><span class="pill ${c.access_paused_at?'bad':c.sub_status?'good':''}">${c.access_paused_at?'Suspended':esc(c.sub_status||'No plan')}</span></td><td data-label=""><div class="customerActions">${!c.is_reseller_owner?`<a class="button secondary btn-sm" href="/reseller/customer/${encodeURIComponent(c.id)}/renew">Renew</a>`:''}<a class="button secondary btn-sm" href="/reseller/client/${encodeURIComponent(c.id)}/credentials">Credentials</a>${!c.is_reseller_owner?`<form method="post" action="/reseller/customer/${encodeURIComponent(c.id)}/toggle">${token(req)}<input type="hidden" name="suspended" value="${c.access_paused_at?'false':'true'}"><button class="button ${c.access_paused_at?'secondary':'btn-danger'} btn-sm">${c.access_paused_at?'Resume':'Suspend'}</button></form>`:''}</div></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty">No customers yet.</div>'}</section>`;
    return shell({title:'Reseller dashboard',subtitle:'Revenue, customers, streaming and your monthly CAPTaINFiN subscription',body});
}

async function renewPage(req){
    const reseller=await resolveReseller(req.session.authUserId); const customer=await monthly.getResellerCustomer(reseller.id,req.params.id); if(!customer)return null;
    const [plans,sub]=await Promise.all([downstreamPlans(),monthly.currentSubscription(reseller.id)]);
    const body=`${notice(req)}<section class="section"><div class="sectionHead"><h2>Renew ${esc(customer.display_name||'customer')}</h2></div><form class="formPanel" method="post" action="/reseller/customer/${encodeURIComponent(customer.id)}/renew">${token(req)}<div class="formGrid"><div class="formGroup"><label>Access plan</label><select class="input" name="planCode">${plans.map(p=>`<option value="${esc(p.code)}">${esc(p.name)} · ${esc(p.duration_days)} days</option>`).join('')}</select></div><div class="formGroup"><label>Amount charged</label><input class="input" type="number" name="amount" min="0" step="0.01" value="0.00"></div><div class="formGroup"><label>Currency</label><input class="input" name="currency" maxlength="3" value="${esc(sub?.currency||'GBP')}"></div><div class="formGroup"><label>Payment method</label><select class="input" name="paymentMethod"><option>Cash</option><option>Bank transfer</option><option>PayPal</option><option>Stripe</option><option>Other</option></select></div><div class="formGroup"><label>Note</label><input class="input" name="note" maxlength="500"></div></div><div class="buttonRow"><button class="button">Record sale & renew access</button><a class="button secondary" href="/reseller">Cancel</a></div></form></section>`;
    return shell({title:'Renew customer',subtitle:'Manual sale · automatic Jellyfin reconciliation',body});
}

function credentialPage(username,password,message){
    return shell({title:'Credentials ready',subtitle:message,body:`<section class="section"><div class="formPanel"><p><strong>Username</strong></p><div class="credentialBox">${esc(username)}</div><p><strong>Password</strong></p><div class="credentialBox">${esc(password)}</div><p class="muted">The password is shown once. Share it securely.</p><a class="button" href="/reseller">Back to dashboard</a></div></section>`});
}

function createResellerMonthlyPortalRouter(){
    const r=express.Router(); r.use('/reseller',gate,noStore);
    r.get('/reseller',async(req,res,next)=>{try{return res.send(await dashboard(req));}catch(e){next(e);}});
    r.get('/reseller/customer/:id/renew',async(req,res,next)=>{try{const page=await renewPage(req);if(!page)return res.status(404).send('Customer not found');return res.send(page);}catch(e){next(e);}});
    r.post('/reseller/billing/stripe',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await resolveReseller(req.session.authUserId);if(await monthly.currentSubscription(reseller.id))throw new Error('You already have a reseller subscription. Contact the administrator to change tiers.');const checkout=await resellerBilling.createStripeCheckout({resellerId:reseller.id,tierId:req.body.tierId,successUrl:absoluteUrl(req,'/reseller?message=Payment%20received.%20Your%20monthly%20subscription%20will%20activate%20as%20soon%20as%20Stripe%20confirms%20it.'),cancelUrl:absoluteUrl(req,'/reseller?error=Checkout%20cancelled')});return res.redirect(303,checkout.url);}catch(e){return redirect(res,'error',e.message);}});
    r.post('/reseller/billing/paypal',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await resolveReseller(req.session.authUserId);if(await monthly.currentSubscription(reseller.id))throw new Error('You already have a reseller subscription. Contact the administrator to change tiers.');const checkout=await resellerBilling.createPayPalCheckout({resellerId:reseller.id,tierId:req.body.tierId,returnUrl:absoluteUrl(req,`/reseller/billing/paypal/return?id=${encodeURIComponent('PENDING')}`),cancelUrl:absoluteUrl(req,'/reseller?error=PayPal%20checkout%20cancelled')});req.session.pendingResellerPayPal=checkout.id;return res.redirect(303,checkout.url);}catch(e){return redirect(res,'error',e.message);}});
    r.get('/reseller/billing/paypal/return',async(req,res)=>{try{const id=String(req.query.subscription_id||req.session.pendingResellerPayPal||'').trim();if(!id)throw new Error('PayPal did not return a subscription ID.');await resellerBilling.activatePayPalSubscription(id);delete req.session.pendingResellerPayPal;return redirect(res,'message','PayPal monthly reseller subscription activated.');}catch(e){return redirect(res,'error',e.message);}});
    r.post('/reseller/billing/cancel',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await resolveReseller(req.session.authUserId);await resellerBilling.cancelRenewal(reseller.id);return redirect(res,'message','Automatic renewal cancelled. Your estate remains active until the paid-through date.');}catch(e){return redirect(res,'error',e.message);}});
    r.post('/reseller/owner/create',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await resolveReseller(req.session.authUserId);const result=await monthly.createOrRenewCustomer({resellerId:reseller.id,username:reseller.username,planCode:req.body.planCode,amount:0,currency:(await monthly.currentSubscription(reseller.id))?.currency||'GBP',paymentMethod:'internal',actorUserId:req.session.authUserId,owner:true});if(!result.reconcile?.account?.id)return redirect(res,'message','Your reseller account was created. Jellyfin provisioning is queued; use Credentials once it finishes.');const password=randomPassword();await provisioning.setJellyfinPassword(result.customer.id,result.reconcile.account.id,password);return res.send(credentialPage(result.reconcile.account.jellyfin_username||reseller.username,password,'Your own Jellyfin account counts as one reseller seat.'));}catch(e){return redirect(res,'error',e.message);}});
    r.post('/reseller/customer/create',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await resolveReseller(req.session.authUserId);const result=await monthly.createOrRenewCustomer({resellerId:reseller.id,username:req.body.username,planCode:req.body.planCode,amount:req.body.amount,currency:req.body.currency,paymentMethod:req.body.paymentMethod,note:req.body.note,actorUserId:req.session.authUserId});if(!result.reconcile?.account?.id)return redirect(res,'message','Customer and sale recorded. Jellyfin provisioning is queued; credentials can be reset once it finishes.');const password=randomPassword();await provisioning.setJellyfinPassword(result.customer.id,result.reconcile.account.id,password);return res.send(credentialPage(result.reconcile.account.jellyfin_username||req.body.username,password,'Customer created, sale recorded and Jellyfin provisioned.'));}catch(e){return redirect(res,'error',e.message);}});
    r.post('/reseller/customer/:id/renew',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await resolveReseller(req.session.authUserId);await monthly.createOrRenewCustomer({resellerId:reseller.id,customerId:req.params.id,planCode:req.body.planCode,amount:req.body.amount,currency:req.body.currency,paymentMethod:req.body.paymentMethod,note:req.body.note,actorUserId:req.session.authUserId});return redirect(res,'message','Sale recorded and customer access renewed.');}catch(e){return redirect(res,'error',e.message);}});
    r.post('/reseller/customer/:id/toggle',async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{const reseller=await resolveReseller(req.session.authUserId);const suspended=String(req.body.suspended)==='true';await monthly.setCustomerManualSuspended({resellerId:reseller.id,customerId:req.params.id,suspended,actorUserId:req.session.authUserId});return redirect(res,'message',suspended?'Customer suspended.':'Customer resumed.');}catch(e){return redirect(res,'error',e.message);}});
    r.use('/reseller',(e,_req,res,_next)=>{console.error('Monthly reseller portal error:',e.message);return res.status(500).send(shell({title:'Reseller dashboard unavailable',body:`<div class="notice error">${esc(e.message||'The dashboard could not load safely.')}</div><a class="button" href="/reseller">Retry</a>`}));});
    return r;
}

module.exports={createResellerMonthlyPortalRouter,resolveReseller,analytics,range,downstreamPlans};
