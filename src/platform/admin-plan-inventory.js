'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const runtimeSettings=require('./runtime-settings');
const capacity=require('../entitlements/plan-capacity');
const ui=require('./admin-ui');
const {esc,layout}=require('./admin-html');

function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
async function plan(id){return(await query('SELECT id,code,name,capacity_limit,service_type,server_class,billing_interval,price_minor,is_free_tier,streams FROM plans WHERE id=$1 AND archived_at IS NULL',[id])).rows[0]||null;}
function isTrial(p){return String(p?.billing_interval||'')==='trial';}
function manualEditor(p,usage,req){
  const trial=isTrial(p),label=trial?'Maximum simultaneous trials':String(p.service_type)==='stremio'?'Maximum Stremio places':'Maximum concurrent plan slots';
  const help=trial?'This remains a hard trial concurrency cap. Trial activation also requires free Premium fleet stream capacity.':String(p.service_type)==='stremio'?'Stremio availability remains manual. Set 0 to close new Stremio acquisition without removing existing access.':'Set 0 to close new acquisition while keeping the plan configured.';
  return `<form class="formPanel" method="post" action="/admin/plans/${esc(p.id)}/inventory"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGroup narrow"><label>${esc(label)}</label><input class="input" type="number" name="capacityLimit" min="0" max="1000000" required value="${esc(p.capacity_limit??'0')}"><div class="inlineHelp">${esc(help)}</div></div><button class="button">Save availability</button></form>`;
}
async function page(req){
  await runtimeSettings.ensureLoaded();
  const p=await plan(req.params.id);if(!p)return null;
  const usage=await capacity.usage(p.id),fleet=usage.model==='fleet_streams';
  const metrics=fleet
    ? `<div class="metrics"><div class="metric"><div class="metricLabel">Fleet stream capacity</div><div class="metricValue">${esc(usage.streamLimit)}</div></div><div class="metric"><div class="metricLabel">Sold / held streams</div><div class="metricValue">${esc(Number(usage.streamUsed||0)+Number(usage.streamReserved||0))}</div></div><div class="metric"><div class="metricLabel">Available places</div><div class="metricValue ${usage.soldOut?'statusBad':'statusGood'}">${esc(usage.remaining)}</div><div class="subText">${esc(usage.label||'Available')} · ${esc(usage.requiredStreams)} stream${Number(usage.requiredStreams)===1?'':'s'} per new customer</div></div></div>`
    : `<div class="metrics"><div class="metric"><div class="metricLabel">Used slots</div><div class="metricValue">${esc(usage.used)}</div></div><div class="metric"><div class="metricLabel">Availability limit</div><div class="metricValue">${usage.limit==null?'—':esc(usage.limit)}</div></div><div class="metric"><div class="metricLabel">Available now</div><div class="metricValue ${usage.soldOut?'statusBad':'statusGood'}">${usage.remaining==null?'Not limited':esc(usage.remaining)}</div></div></div>`;
  const derived=fleet&&!isTrial(p);
  const sectionHead=ui.sectionHeader({title:'Storefront availability',description:derived?'Jellyfin availability is shared across the eligible server fleet and is no longer configured independently on each paid/free plan.':'Control the manual acquisition cap without changing existing customer entitlements.'});
  const controls=derived
    ? `<div class="formPanel"><strong>${esc(usage.pool==='free'?'Free':'Premium')} fleet controls this plan.</strong><p class="muted">CAPTAiNFiN adds the sellable stream capacity from eligible ${esc(usage.pool)} Jellyfin servers, subtracts the stream entitlements already sold or held in checkout, then converts the remainder into real customer places for this ${esc(usage.requiredStreams)}-stream plan.</p><div class="buttonRow"><a class="button" href="/admin/servers">Manage server capacity</a><a class="button secondary" href="/admin/plans">Back to plans</a></div></div>`
    : manualEditor(p,usage,req);
  const safety=ui.confirmationPanel({tone:'info',title:'Existing customer access is preserved',body:'Availability controls new acquisition only. Existing subscriptions keep the access they already bought.',items:[derived?'Changing server stream capacity changes the shared storefront availability for every plan in this fleet.':'Set 0 to stop new acquisition without disabling the plan.',isTrial(p)?'Trials are limited by both this manual cap and remaining Premium stream capacity.':String(p.service_type)==='stremio'?'Stremio places continue to use this manual plan limit.':'Raising the limit reopens acquisition when the product is otherwise ready.']});
  const body=`${ui.noticesFromRequest(req)}${metrics}<section class="section">${sectionHead}${controls}${safety}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plans',title:`${p.name} · Availability`,subtitle:derived?'Shared fleet stream capacity and live scarcity':'Manual acquisition capacity',body});
}
function createAdminPlanInventoryRouter(){
  const r=express.Router();r.use('/admin/plans/:id/inventory',gate,noStore);
  r.get('/admin/plans/:id/inventory',async(req,res,next)=>{try{const html=await page(req);return html?res.send(html):res.status(404).send('Plan not found');}catch(error){next(error)}});
  r.post('/admin/plans/:id/inventory',async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const p=await plan(req.params.id);if(!p)throw new Error('Plan not found.');
      if(capacity.capacityModel(p)==='fleet_streams'&&!isTrial(p))throw new Error('Paid and Free Jellyfin availability is controlled by server stream capacity.');
      const raw=String(req.body.capacityLimit||'').trim(),n=Number.parseInt(raw,10);if(!Number.isInteger(n)||String(n)!==raw||n<0||n>1000000)throw new Error('Availability limit must be a whole number from 0 to 1,000,000.');
      await transaction(async client=>{const updated=await client.query('UPDATE plans SET capacity_limit=$2,updated_at=NOW() WHERE id=$1 AND archived_at IS NULL RETURNING code,name',[req.params.id,n]);if(!updated.rowCount)throw new Error('Plan not found.');await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.inventory.update','plan',$2,$3::jsonb)`,[req.session.authUserId,req.params.id,JSON.stringify({capacityLimit:n,capacityModel:capacity.capacityModel(p)})]);});
      return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/inventory?message=${encodeURIComponent(n===0?'Plan availability closed at 0 slots.':'Plan availability saved.')}`);
    }catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/inventory?error=${encodeURIComponent(error.message)}`)}
  });return r;
}
module.exports={createAdminPlanInventoryRouter,page};
