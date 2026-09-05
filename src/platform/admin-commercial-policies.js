'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const lifecycle=require('../payments/lifecycle');
const runtimeSettings=require('./runtime-settings');
const {layout,esc}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired')}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next()}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`}
function checked(v){return v?'checked':''}
function notice(req){return `${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}`}

async function accessData(){
  const [policy,freePlans]=await Promise.all([
    lifecycle.trialPolicy(),
    query(`SELECT code,name,duration_days FROM plans WHERE active=TRUE AND visible=TRUE AND archived_at IS NULL AND price_minor=0 AND billing_interval<>'trial' AND audience IN('direct','both') ORDER BY is_free_tier DESC,sort_order,name`)
  ]);
  return{policy,freePlans:freePlans.rows};
}

async function accessPage(req){
  await runtimeSettings.ensureLoaded();
  const d=await accessData(),p=d.policy;
  const body=`${notice(req)}<div class="operatorCallout"><strong>Plan-level acquisition policy.</strong> These rules decide who may claim trial and free access and what happens when paid access expires. Individual plan delivery, capacity and Jellyfin policy remain on each plan.</div><section class="section"><div class="sectionHead"><h2>Trial & free access rules</h2><span class="muted">Enforced server-side</span></div><form class="formPanel" method="post" action="/admin/commerce/policy">${token(req)}<div class="formGrid"><div class="formGroup"><label>Trial eligibility</label><select class="input" name="trialMode"><option value="once_ever" ${p.trialMode==='once_ever'?'selected':''}>One trial ever</option><option value="once_per_plan" ${p.trialMode==='once_per_plan'?'selected':''}>One trial per trial plan</option><option value="before_paid" ${p.trialMode==='before_paid'?'selected':''}>Only before first paid subscription</option></select></div><div class="formGroup"><label>Free-plan claims</label><select class="input" name="freeMode"><option value="once_per_plan" ${p.freeMode==='once_per_plan'?'selected':''}>One claim per free plan</option><option value="renewable" ${p.freeMode==='renewable'?'selected':''}>Renewable after expiry</option><option value="permanent" ${p.freeMode==='permanent'?'selected':''}>Permanent entitlement</option></select></div></div><div class="toggleGrid"><label class="toggleRow"><input type="checkbox" name="paidCanClaimFree" value="1" ${checked(p.paidCanClaimFree)}><span>Allow a paid customer to queue/claim free access</span></label><label class="toggleRow"><input type="checkbox" name="downgradeToFree" value="1" ${checked(p.downgradeToFree)}><span>Automatically downgrade an expired paid customer to a free plan</span></label></div><div class="formGroup"><label>Automatic downgrade target</label><select class="input" name="downgradeFreePlanCode"><option value="">None</option>${d.freePlans.map(plan=>`<option value="${esc(plan.code)}" ${p.downgradeFreePlanCode===plan.code?'selected':''}>${esc(plan.name)} · ${esc(plan.duration_days||30)} days</option>`).join('')}</select><div class="inlineHelp">Only current free customer plans are shown.</div></div><button class="button">Save access rules</button></form></section><div class="buttonRow"><a class="button secondary" href="/admin/plans">Back to Plans</a><a class="button secondary" href="/admin/request-plan-policy">Request limits</a></div>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plan-access-rules',title:'Plan Access Rules',subtitle:'Trial, free-access and paid-to-free lifecycle policy',body});
}

async function riskPage(req){
  await runtimeSettings.ensureLoaded();
  const body=`${notice(req)}<div class="operatorCallout"><strong>A refund, dispute or chargeback under review is not an access state.</strong> It is always recorded as a payment incident, visible here and on the customer's record, but it can no longer suspend service on its own - that removed a straightforward "paid = service present, not paid = service absent" lifecycle behind a second, hold-based one. A <strong>confirmed</strong> refund still removes the associated paid plan, and normal reconciliation removes the related service exactly as an expiry or cancellation would.</div><section class="section"><div class="sectionHead"><h2>If a specific customer genuinely needs access removed while a case is investigated</h2><span class="muted">Explicit, audited, reversible</span></div><div class="operatorCallout">Use that customer's Customer 360 page and choose <strong>Remove access</strong> for the relevant service. That is a direct, authoritative administrator decision (survives any subsequent payment webhook until you return the customer to automatic management) rather than an automatic hold a webhook can also silently re-trigger.</div></section><div class="buttonRow"><a class="button secondary" href="/admin/payments">Back to Payment providers</a><a class="button secondary" href="/admin/commerce">View Commerce overview</a></div>`;
  return layout({siteName:runtimeSettings.siteName(),active:'payment-risk-policy',title:'Payment Risk Policy',subtitle:'Refunds, disputes and chargebacks no longer gate access',body});
}

function createAdminCommercialPoliciesRouter(){
  const router=express.Router();
  router.use(['/admin/plans/access-rules','/admin/payments/risk-policy'],gate,noStore);
  router.get('/admin/plans/access-rules',async(req,res,next)=>{try{return res.send(await accessPage(req))}catch(error){next(error)}});
  router.get('/admin/payments/risk-policy',async(req,res,next)=>{try{return res.send(await riskPage(req))}catch(error){next(error)}});
  return router;
}

module.exports={createAdminCommercialPoliciesRouter,accessPage,riskPage,accessData};
