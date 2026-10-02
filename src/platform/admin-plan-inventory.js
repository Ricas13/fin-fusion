'use strict';

const express=require('express');
const {query}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');
const capacity=require('../entitlements/plan-capacity');
const planCommands=require('../catalog/plan-command-service');
const ui=require('./admin-ui');
const {esc,layout}=require('./admin-html');

const inventoryWriteLimit=routeRateLimit.middleware({scope:'admin-plan-inventory',max:30,windowSeconds:60,reason:'admin_plan_inventory'});

/*
 * Jellyfin availability has two independent ceilings: every managed customer
 * consumes one physical place from the eligible server fleet, and the plan may
 * expose only a smaller commercial allocation of that pool. Concurrent-stream
 * limits remain access policy, never inventory/capacity weighting. Stremio-only
 * plans retain their separate household-unit inventory model.
 */
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
async function plan(id){return(await query('SELECT id,code,name,capacity_limit,service_type,server_class,billing_interval,price_minor,is_free_tier,streams,stremio_household_network_limit FROM plans WHERE id=$1 AND archived_at IS NULL',[id])).rows[0]||null;}
async function liveCustomers(planId){const result=await query(`SELECT COUNT(DISTINCT customer_id)::int count FROM subscriptions WHERE plan_id=$1 AND superseded_by IS NULL AND status IN('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW()`,[planId]);return Number(result.rows[0]?.count||0);}
function isStremio(p){return String(p?.service_type||'')==='stremio';}

function manualEditor(p,usage,req){
  const fleet=usage.model==='fleet_users',stremio=isStremio(p);
  const label=fleet?'Maximum plan customers':stremio?'Customer availability units':'Maximum concurrent customers';
  const help=fleet
    ? 'This is the plan allocation inside the eligible server pool. Leave blank for no additional plan cap, set 0 to close new acquisition, or set a lower number than the physical fleet capacity to reserve only that many places for this plan.'
    : stremio
      ? 'For a normal 1-household plan, one unit equals one customer place. Larger household variants consume proportionally more units. Set 0 to close new Stremio acquisition without removing existing access.'
      : 'Set 0 to close new acquisition while keeping existing customer access unchanged.';
  const required=fleet?'':' required';
  const value=fleet?(p.capacity_limit??''):(p.capacity_limit??'0');
  return `<form class="formPanel" method="post" action="/admin/plans/${esc(p.id)}/inventory"><input type="hidden" name="_csrf" value="${esc(csrf.token(req))}"><div class="formGroup narrow"><label>${esc(label)}</label><input class="input" type="number" name="capacityLimit" min="0" max="1000000"${required} value="${esc(value)}" placeholder="${fleet?'No additional plan cap':'0'}"><div class="inlineHelp">${esc(help)}</div></div><button class="button">Save availability</button></form>`;
}

async function page(req){
  await runtimeSettings.ensureLoaded();
  const p=await plan(req.params.id);if(!p)return null;
  const [usage,customers]=await Promise.all([capacity.usage(p.id),liveCustomers(p.id)]),fleet=usage.model==='fleet_users',stremioHouseholds=usage.model==='manual_households';
  const metrics=fleet
    ? `<div class="metrics"><div class="metric"><div class="metricLabel">Customers on this plan</div><div class="metricValue">${esc(customers)}</div></div><div class="metric"><div class="metricLabel">Plan customer limit</div><div class="metricValue">${usage.planLimit==null?'No extra cap':esc(usage.planLimit)}</div></div><div class="metric"><div class="metricLabel">Eligible server capacity</div><div class="metricValue">${esc(usage.physicalLimit??usage.userLimit??0)}</div><div class="subText">Physical hard ceiling</div></div><div class="metric"><div class="metricLabel">New places available</div><div class="metricValue ${usage.soldOut?'statusBad':'statusGood'}">${esc(usage.remaining)}</div><div class="subText">${esc(usage.label||'Available')} · lowest ceiling wins</div></div></div>`
    : stremioHouseholds
      ? `<div class="metrics"><div class="metric"><div class="metricLabel">Customers on this plan</div><div class="metricValue">${esc(customers)}</div></div><div class="metric"><div class="metricLabel">Base-plan customer capacity</div><div class="metricValue">${usage.limit==null?'—':esc(usage.limit)}</div></div><div class="metric"><div class="metricLabel">New places available</div><div class="metricValue ${usage.soldOut?'statusBad':'statusGood'}">${usage.remaining==null?'Not limited':esc(usage.remaining)}</div><div class="subText">${esc(usage.label||'Available')}</div></div></div>`
      : `<div class="metrics"><div class="metric"><div class="metricLabel">Customers on this plan</div><div class="metricValue">${esc(customers)}</div></div><div class="metric"><div class="metricLabel">Customer limit</div><div class="metricValue">${usage.limit==null?'—':esc(usage.limit)}</div></div><div class="metric"><div class="metricLabel">New places available</div><div class="metricValue ${usage.soldOut?'statusBad':'statusGood'}">${usage.remaining==null?'Not limited':esc(usage.remaining)}</div></div></div>`;
  const description=fleet
    ? 'Jellyfin availability is the lower of this plan allocation and the remaining physical capacity across its eligible servers. Every customer uses one physical server place.'
    : stremioHouseholds?'Stremio availability is presented as customer places; larger household variants consume more of the same inventory automatically.':'Control the customer acquisition cap without changing existing customer entitlements.';
  const sectionHead=ui.sectionHeader({title:'Storefront availability',description});
  const physical=fleet?`<div class="securityNote standalone"><strong>Physical fleet:</strong> configured capacity <strong>${esc(usage.physicalLimit??usage.userLimit??0)}</strong> · occupied/owed <strong>${esc(usage.physicalUsed??usage.userUsed??0)}</strong> · remaining <strong>${esc(usage.physicalRemaining??usage.userRemaining??0)}</strong>. Change physical limits under <a href="/admin/servers">Servers</a>; change which servers this plan may use under its Delivery & server placement card.</div>`:'';
  const controls=`${manualEditor(p,usage,req)}${physical}`;
  const safety=ui.confirmationPanel({tone:'info',title:'Existing customer access is preserved',body:'Availability controls new acquisition only. Existing subscriptions keep the access they already have.',items:[
    fleet?'The physical server max_users limit can never be exceeded even if the plan limit is higher.':stremioHouseholds?'A customer buying a larger Stremio household variant consumes proportionally more of the shared plan inventory.':'Set 0 to stop new acquisition without disabling the plan.',
    fleet?'A lower plan limit reserves only part of the eligible fleet for this plan; lowering it below current usage simply closes new acquisition.':stremioHouseholds?'Set 0 to stop new Stremio purchases while existing customer entitlements continue normally.':'Raising the limit reopens acquisition when the product is otherwise ready.'
  ]});
  const body=`${ui.noticesFromRequest(req)}${metrics}<section class="section">${sectionHead}${controls}${safety}</section>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plans',title:`${p.name} · Availability`,subtitle:fleet?'Plan allocation inside physical server capacity':stremioHouseholds?'Customer availability and live scarcity':'Customer acquisition capacity',body});
}

function createAdminPlanInventoryRouter(){
  const r=express.Router();r.use('/admin/plans/:id/inventory',gate,noStore);
  r.get('/admin/plans/:id/inventory',async(req,res,next)=>{try{const html=await page(req);return html?res.send(html):res.status(404).send('Plan not found');}catch(error){next(error)}});
  r.post('/admin/plans/:id/inventory',inventoryWriteLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const p=await plan(req.params.id);if(!p)throw new Error('Plan not found.');
      const fleet=capacity.capacityModel(p)==='fleet_users';
      const raw=String(req.body.capacityLimit??'').trim();
      let n=null;
      if(!(fleet&&raw==='')){
        n=Number.parseInt(raw,10);
        if(!Number.isInteger(n)||String(n)!==raw||n<0||n>1000000)throw new Error('Availability limit must be a whole number from 0 to 1,000,000.');
      }
      await planCommands.updateAvailability({planId:req.params.id,capacityLimit:n,actorUserId:req.session.authUserId});
      const message=n===0?'Plan availability closed at 0 places.':n==null?'Plan now uses all capacity available to its eligible servers.':'Plan availability saved.';
      return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/inventory?message=${encodeURIComponent(message)}`);
    }catch(error){return res.redirect(`/admin/plans/${encodeURIComponent(req.params.id)}/inventory?error=${encodeURIComponent(error.message)}`)}
  });return r;
}
module.exports={createAdminPlanInventoryRouter,page,liveCustomers};
