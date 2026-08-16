'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');
const productReadiness=require('./product-readiness');
const {layout,esc}=require('./admin-html');

const mutationLimit=routeRateLimit.middleware({scope:'admin-plan-delivery',max:20,windowSeconds:300});
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function token(req){return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;}
async function data(planId){
  const [plan,live,ctx]=await Promise.all([
    query('SELECT * FROM plans WHERE id=$1',[planId]),
    query(`SELECT COUNT(DISTINCT customer_id)::int n FROM subscriptions WHERE plan_id=$1 AND superseded_by IS NULL AND status IN ('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW()`,[planId]),
    productReadiness.context()
  ]);
  if(!plan.rowCount)return null;
  const row=plan.rows[0];
  return{plan:row,live:Number(live.rows[0]?.n||0),readiness:productReadiness.evaluate(row,ctx),ctx};
}
async function page(req){
  await runtimeSettings.ensureLoaded();const d=await data(req.params.id);if(!d)return null;const p=d.plan;
  const option=(value,label,copy)=>`<label class="choice"><input type="radio" name="serviceType" value="${value}" ${productReadiness.serviceType(p)===value?'checked':''}> <strong>${esc(label)}</strong><div class="muted">${esc(copy)}</div></label>`;
  const impact=d.live?`<div class="notice warn"><strong>${d.live} live customer entitlement${d.live===1?'':'s'} reference this catalogue plan.</strong> Their immutable service snapshots will not be changed. Type <strong>${esc(p.code)}</strong> to confirm the catalogue change.</div><div class="formGroup"><label>Impact confirmation</label><input class="input" name="impactConfirmation" required autocomplete="off" placeholder="${esc(p.code)}"></div>`:'';
  const body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}<div class="statusBanner ${d.readiness.sellable?'good':'warn'}"><strong>Current sale state: ${esc(d.readiness.label)}.</strong> Delivery is ${esc(productReadiness.deliveryLabel(p))}. Existing subscriptions keep the service type snapshotted when they were created.</div><section class="section"><div class="sectionHead"><div><h2>Delivery service</h2><div class="settings-hint">Choose what new subscriptions to this plan receive.</div></div><a class="button secondary" href="/admin/plans/${esc(p.id)}/edit">Back to plan</a></div><form class="formPanel" method="post" action="/admin/plans/${esc(p.id)}/delivery">${token(req)}${option('jellyfin','Jellyfin','Normal Jellyfin account and customer-facing Jellyfin controls.')}${option('stremio','Stremio','Private Stremio addon installation backed by a hidden restricted Jellyfin identity.')}${option('bundle','Jellyfin + Stremio','Both a normal Jellyfin account and a customer-controlled Stremio installation.')}${impact}<button class="button">Save delivery service</button></form></section><section class="section"><div class="sectionHead"><h2>Stremio readiness</h2></div><div class="grid three"><div class="detail-card"><strong>${d.ctx.stremio.runtimeReady?'Ready':'Not ready'}</strong><small>Runtime</small></div><div class="detail-card"><strong>${esc(d.ctx.stremio.eligibleServers)}</strong><small>Eligible server(s)</small></div><div class="detail-card"><strong>${esc(d.ctx.stremio.readyIndexes)}</strong><small>Ready media index(es)</small></div></div><p><a class="button secondary" href="/admin/settings/stremio">Open Stremio readiness</a></p></section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plans',title:p.name,subtitle:'Delivery service for new subscriptions',body});
}
function createAdminPlanDeliveryRouter(){
  const r=express.Router();r.use('/admin/plans',gate,noStore);
  r.get('/admin/plans/:id/delivery',async(req,res,next)=>{try{const html=await page(req);return html?res.send(html):res.status(404).send('Plan not found');}catch(error){next(error);}});
  r.post('/admin/plans/:id/delivery',mutationLimit,async(req,res)=>{if(!csrf.verify(req))return res.status(403).send('Invalid security token');try{
    const nextType=['jellyfin','stremio','bundle'].includes(String(req.body.serviceType))?String(req.body.serviceType):null;if(!nextType)throw new Error('Choose a valid delivery service.');
    await transaction(async client=>{
      const found=await client.query('SELECT * FROM plans WHERE id=$1 FOR UPDATE',[req.params.id]);if(!found.rowCount)throw new Error('Plan not found.');const plan=found.rows[0];
      const live=await client.query(`SELECT COUNT(DISTINCT customer_id)::int n FROM subscriptions WHERE plan_id=$1 AND superseded_by IS NULL AND status IN ('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW()`,[plan.id]),count=Number(live.rows[0]?.n||0);
      if(count&&String(req.body.impactConfirmation||'').trim()!==String(plan.code))throw new Error(`Type ${plan.code} exactly to confirm this catalogue change.`);
      if(nextType!=='jellyfin'&&plan.active&&plan.visible){const readiness=productReadiness.evaluate({...plan,service_type:nextType},await productReadiness.context());if(!readiness.sellable)throw new Error(`Hide or disable this plan, or finish Stremio readiness first: ${readiness.label}.`);}
      await client.query('UPDATE plans SET service_type=$2,updated_at=NOW() WHERE id=$1',[plan.id,nextType]);
      await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.delivery.update','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify({from:productReadiness.serviceType(plan),to:nextType,liveSubscriptions:count,snapshotsPreserved:true})]);
    });
    return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/delivery?message=${encodeURIComponent('Delivery service updated for future subscriptions. Existing subscription snapshots were preserved.')}`);
  }catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/delivery?error=${encodeURIComponent(error.message)}`);}});
  return r;
}
module.exports={createAdminPlanDeliveryRouter,page,data};
