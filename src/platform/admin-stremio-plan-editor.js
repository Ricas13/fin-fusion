'use strict';

const express=require('express');
const {query,transaction}=require('../db');
const csrf=require('../auth/csrf');
const routeRateLimit=require('../security/route-rate-limit');
const runtimeSettings=require('./runtime-settings');
const planPricing=require('../payments/plan-pricing');
const sourcePool=require('../stremio/source-pool');
const planComponents=require('../access/plan-components');
const {esc,layout}=require('./admin-html');

const writeLimit=routeRateLimit.middleware({scope:'admin-stremio-plan-editor',max:30,windowSeconds:60,reason:'admin_stremio_plan_editor'});
const BILLING=new Set(['trial','month','6_months','year','custom']);
const REPLACEMENT_POLICIES=new Set(['auto_inactive','customer_cooldown']);
function gate(req,res,next){return req.session?.authUserId&&req.session?.authRole==='admin'&&req.session?.adminId?next():res.redirect('/login?session=expired');}
function noStore(_req,res,next){res.setHeader('Cache-Control','no-store, private, max-age=0');res.setHeader('Pragma','no-cache');next();}
function text(value,max=500){return String(value||'').trim().slice(0,max);}
function bool(value){return value===true||['1','true','on','yes'].includes(String(value||'').toLowerCase());}
function int(value,min,max,label){const raw=String(value??'').trim(),parsed=Number.parseInt(raw,10);if(!Number.isInteger(parsed)||String(parsed)!==raw||parsed<min||parsed>max)throw new Error(`${label} must be a whole number from ${min} to ${max}.`);return parsed;}
function money(value){const raw=String(value??'').trim();if(!/^\d+(?:\.\d{1,2})?$/.test(raw))throw new Error('Enter a valid non-negative price with no more than two decimal places.');const amount=Number(raw);if(!Number.isFinite(amount)||amount<0||amount>100000)throw new Error('Price must be between 0 and 100,000.');return Math.round(amount*100);}
function features(value){return [...new Set(String(value||'').split(/\r?\n/).map(v=>v.trim()).filter(Boolean).map(v=>v.slice(0,160)))].slice(0,20);}
function checked(value){return value?'checked':'';}
function selected(a,b){return String(a)===String(b)?'selected':'';}
function formatPrice(minor,currency){try{return new Intl.NumberFormat('en-GB',{style:'currency',currency:String(currency||'GBP').trim(),minimumFractionDigits:2,maximumFractionDigits:2}).format(Number(minor||0)/100);}catch{return `${currency||'GBP'} ${(Number(minor||0)/100).toFixed(2)}`;}}
function activeSubscriptionSql(extra=''){return `plan_id=$1 AND superseded_by IS NULL AND status IN ('active','trialing','past_due','paused') AND starts_at<=NOW() AND current_period_end>NOW() ${extra}`;}

async function loadData(planId){
  const planResult=await query('SELECT * FROM plans WHERE id=$1',[planId]);
  if(!planResult.rowCount)return null;
  const plan=planResult.rows[0];
  const [live,price,sources]=await Promise.all([
    query(`SELECT COUNT(DISTINCT customer_id)::int n FROM subscriptions WHERE ${activeSubscriptionSql()}`,[planId]),
    planPricing.resolvePortalPrice(planId).catch(()=>null),
    sourcePool.planSources(planId).catch(()=>[])
  ]);
  return{plan,live:Number(live.rows[0]?.n||0),price:price||{price_minor:plan.price_minor,currency:plan.currency},sources};
}

function viewValues(data,input=null){
  const p=data.plan,submitted=Boolean(input?.__submitted),source=input||{};
  return{
    name:submitted?source.name:p.name,
    description:submitted?source.description:p.description,
    price:submitted?source.price:(Number(data.price?.price_minor||0)/100).toFixed(2),
    currency:data.price?.currency||p.currency||'GBP',
    billingInterval:submitted?source.billingInterval:p.billing_interval,
    durationDays:submitted?source.durationDays:p.duration_days,
    householdLimit:submitted?source.householdLimit:(p.stremio_household_network_limit||1),
    replacementPolicy:submitted?source.replacementPolicy:(p.stremio_ip_replacement_policy||'auto_inactive'),
    cooldownMinutes:submitted?source.cooldownMinutes:(p.stremio_ip_replacement_cooldown_minutes||1440),
    capacityLimit:submitted?source.capacityLimit:(p.capacity_limit||0),
    active:submitted?bool(source.active):Boolean(p.active),
    visible:submitted?bool(source.visible):Boolean(p.visible),
    marketingFeatures:submitted?source.marketingFeatures:Array.isArray(p.marketing_features)?p.marketing_features.join('\n'):''
  };
}

function parse(body){
  const name=text(body.name,80);if(!name)throw new Error('Enter a plan name.');
  const billingInterval=BILLING.has(String(body.billingInterval))?String(body.billingInterval):'month';
  const replacementPolicy=REPLACEMENT_POLICIES.has(String(body.replacementPolicy))?String(body.replacementPolicy):'customer_cooldown';
  return{
    name,
    description:text(body.description,500),
    priceMinor:money(body.price),
    billingInterval,
    durationDays:int(body.durationDays,1,3650,'Duration'),
    householdLimit:int(body.householdLimit,1,10,'Household IPs'),
    replacementPolicy,
    cooldownMinutes:replacementPolicy==='customer_cooldown'?int(body.cooldownMinutes,15,1440,'IP replacement cooldown'):1440,
    capacityLimit:int(body.capacityLimit,0,1000000,'Capacity'),
    active:bool(body.active),
    visible:bool(body.visible),
    marketingFeatures:features(body.marketingFeatures)
  };
}

function householdImpact(plan,input){
  const oldLimit=Number(plan.stremio_household_network_limit||1),oldPolicy=String(plan.stremio_ip_replacement_policy||'auto_inactive'),oldCooldown=Number(plan.stremio_ip_replacement_cooldown_minutes||1440);
  const changed=oldLimit!==input.householdLimit||oldPolicy!==input.replacementPolicy||oldCooldown!==input.cooldownMinutes;
  const reasons=[];
  if(input.householdLimit<oldLimit)reasons.push(`Household IP allowance ${oldLimit} → ${input.householdLimit}`);
  if(oldPolicy==='auto_inactive'&&input.replacementPolicy==='customer_cooldown')reasons.push('IP replacement changes to customer-controlled cooldown');
  if(oldPolicy==='customer_cooldown'&&input.replacementPolicy==='customer_cooldown'&&input.cooldownMinutes>oldCooldown)reasons.push(`IP replacement cooldown ${oldCooldown} → ${input.cooldownMinutes} minutes`);
  return{changed,restrictive:reasons.length>0,reasons,oldLimit,oldPolicy,oldCooldown};
}

function sourceState(source){
  if(!source.enabled)return{label:'Disabled',kind:'warn'};
  if(source.auth_state!=='connected')return{label:'Reconnect',kind:'bad'};
  if(source.index_status!=='ready'||Number(source.item_count||0)<1)return{label:'Index not ready',kind:'warn'};
  return{label:'Ready',kind:'good'};
}
function sourceControls(sources){
  const selectedSources=sources.filter(source=>source.selected);
  const readySelected=selectedSources.filter(source=>sourceState(source).kind==='good').length;
  const summary=selectedSources.length
    ? `<div class="stremioSourceSummary"><strong>${readySelected}/${selectedSources.length} selected source${selectedSources.length===1?'':'s'} ready</strong><div class="muted">Selected sources are additional Jellyfin sources for this plan. Managed CAPTAiNFiN sources remain automatic.</div></div>`
    : `<div class="stremioSourceSummary"><strong>No additional sources selected</strong><div class="muted">That is valid. Managed CAPTAiNFiN sources are still considered automatically when available.</div></div>`;
  if(!sources.length)return `${summary}<div class="empty">No additional Jellyfin sources are configured yet.</div>`;
  const rows=sources.map(source=>{
    const state=sourceState(source);
    return `<div class="stremioSourceChoice"><label class="stremioSourceMain"><input type="checkbox" name="sourceId" value="${esc(source.id)}" ${source.selected?'checked':''}><span><strong>${esc(source.name)}</strong><small>${Number(source.selected_libraries||0).toLocaleString('en-GB')} selected ${Number(source.selected_libraries||0)===1?'library':'libraries'} · ${Number(source.item_count||0).toLocaleString('en-GB')} indexed titles</small></span></label><span class="pill ${state.kind}">${esc(state.label)}</span><label class="stremioSourcePriority"><span>Priority</span><input class="input" type="number" min="1" max="10000" name="priority_${esc(source.id)}" value="${esc(source.plan_priority||100)}" aria-label="${esc(source.name)} priority"></label></div>`;
  }).join('');
  return `${summary}<div class="stremioSourceChoices">${rows}</div>`;
}

function impactPanel(data,impact){
  if(!impact?.restrictive||!data.live)return'';
  return `<div class="impactPanel"><div class="notice warn"><strong>This access change can affect ${esc(data.live)} existing customer${data.live===1?'':'s'}.</strong>${impact.reasons.map(reason=>`<div>${esc(reason)}</div>`).join('')}</div><fieldset class="impactChoices"><legend>Who should receive the new access rule?</legend><label class="choice"><input type="radio" name="impactScope" value="new_only" required> <strong>New purchases only</strong><span>Existing subscriptions keep their current household allowance and replacement policy.</span></label><label class="choice"><input type="radio" name="impactScope" value="existing" required> <strong>Existing customers too</strong><span>Update active subscriptions and reset their household leases so the new rule takes effect.</span></label></fieldset></div>`;
}

function page(data,req,{input=null,error='',impact=null}={}){
  const p=data.plan,v=viewValues(data,input),component=planComponents.stremioHouseholdConfig({...p,stremio_household_network_limit:v.householdLimit,stremio_ip_replacement_policy:v.replacementPolicy,stremio_ip_replacement_cooldown_minutes:v.cooldownMinutes});
  const cooldownHours=Math.max(1,Math.round(Number(v.cooldownMinutes||1440)/60));
  const csrfValue=esc(csrf.token(req));
  const body=`${req.query.message?`<div class="notice success">${esc(req.query.message)}</div>`:''}${req.query.error?`<div class="notice error">${esc(req.query.error)}</div>`:''}${error?`<div class="notice error">${esc(error)}</div>`:''}
  <section class="stremioPlanHero" data-plan-service="stremio"><div><span class="pill good">STREMIO</span><h2>${esc(v.name||p.name)}</h2><strong>${esc(formatPrice(Number(String(v.price||'0'))*100,v.currency))} · ${esc(v.billingInterval)}</strong><div class="muted">Unlimited streams · Unlimited devices · ${esc(component.networkLimit)} household IP${component.networkLimit===1?'':'s'}</div></div><div><span class="pill ${v.active?'good':'warn'}">${v.active?'LIVE':'INACTIVE'}</span></div></section>
  <form method="post" action="/admin/plans/${esc(p.id)}/stremio-editor" class="stremioPlanForm"><input type="hidden" name="_csrf" value="${csrfValue}"><input type="hidden" name="__submitted" value="1">
    <div class="stremioPlanGrid">
      <section class="section stremioCard"><div class="sectionHead"><h3>Plan</h3></div><div class="formGroup"><label>Name</label><input class="input" name="name" maxlength="80" required value="${esc(v.name||'')}"></div><div class="formGrid"><div class="formGroup"><label>Price</label><div class="inputUnit"><input class="input" type="number" step="0.01" min="0" max="100000" name="price" required value="${esc(v.price)}"><span>${esc(v.currency)}</span></div></div><div class="formGroup"><label>Billing interval</label><select class="input" name="billingInterval"><option value="trial" ${selected('trial',v.billingInterval)}>Trial</option><option value="month" ${selected('month',v.billingInterval)}>Monthly</option><option value="6_months" ${selected('6_months',v.billingInterval)}>6 months</option><option value="year" ${selected('year',v.billingInterval)}>Yearly</option><option value="custom" ${selected('custom',v.billingInterval)}>Custom</option></select></div><div class="formGroup"><label>Duration (days)</label><input class="input" type="number" min="1" max="3650" name="durationDays" required value="${esc(v.durationDays)}"></div></div></section>
      <section class="section stremioCard"><div class="sectionHead"><h3>Access</h3></div><div class="accessFacts"><div><span>Streams</span><strong>Unlimited</strong></div><div><span>Devices</span><strong>Unlimited</strong></div></div><div class="formGroup"><label>Household IPs</label><input class="input" type="number" min="1" max="10" name="householdLimit" required value="${esc(v.householdLimit)}"><div class="inlineHelp">Maximum number of different internet connections that may use this Stremio configuration.</div></div><div class="formGroup"><label>IP replacement</label><select class="input" name="replacementPolicy"><option value="customer_cooldown" ${selected('customer_cooldown',v.replacementPolicy)}>Customer can replace after cooldown</option><option value="auto_inactive" ${selected('auto_inactive',v.replacementPolicy)}>Automatically replace an inactive IP</option></select></div><details class="advancedCard"><summary>Advanced replacement settings</summary><div class="formGroup"><label>Replacement cooldown</label><div class="inputUnit"><input class="input" type="number" min="15" max="1440" name="cooldownMinutes" value="${esc(v.cooldownMinutes)}"><span>minutes</span></div><div class="inlineHelp">Default for new plans: 24 hours. Current value is approximately ${esc(cooldownHours)} hour${cooldownHours===1?'':'s'}.</div></div></details></section>
      <section class="section stremioCard"><div class="sectionHead"><h3>Availability</h3></div><div class="toggleGrid"><label class="toggleRow"><input type="checkbox" name="active" ${checked(v.active)}><span><strong>Available for purchase</strong><small>Allows this plan to participate in new sales when the rest of its readiness checks pass.</small></span></label><label class="toggleRow"><input type="checkbox" name="visible" ${checked(v.visible)}><span><strong>Visible on storefront</strong><small>Show this plan to customers.</small></span></label></div><div class="formGroup"><label>Capacity</label><input class="input" type="number" min="0" max="1000000" name="capacityLimit" required value="${esc(v.capacityLimit)}"></div></section>
      <section class="section stremioCard storefrontCard"><div class="sectionHead"><h3>Storefront</h3></div><div class="formGroup"><label>Description</label><textarea class="input" name="description" maxlength="500" rows="4">${esc(v.description||'')}</textarea></div><div class="formGroup"><label>Benefits / features</label><textarea class="input" name="marketingFeatures" rows="6" placeholder="Unlimited devices\nUnlimited simultaneous streams\nHousehold access">${esc(v.marketingFeatures||'')}</textarea><div class="inlineHelp">One customer-facing benefit per line.</div></div></section>
    </div>
    ${impactPanel(data,impact)}
    <div class="stremioSaveBar"><button class="button" type="submit">Save changes</button><a class="button secondary" href="/admin/plans">Back to Plans</a>${p.archived_at?'':`<a class="button secondary" href="/admin/plans/${esc(p.id)}/archive-confirm">Archive</a>`}</div>
  </form>
  <section class="section stremioSourcesCard"><div class="sectionHead"><div><h3>Stremio sources</h3><div class="muted">Managed CAPTAiNFiN sources are automatic. Choose any additional Jellyfin sources this plan may use.</div></div><a class="button secondary" href="/admin/servers/stremio">Manage sources</a></div><form class="stremioSourcesForm" method="post" action="/admin/plans/${esc(p.id)}/stremio-sources"><input type="hidden" name="_csrf" value="${csrfValue}">${sourceControls(data.sources)}<div class="buttonRow"><button class="button" type="submit">Save sources</button></div></form></section>
  <style>.stremioPlanHero{display:flex;align-items:flex-start;justify-content:space-between;gap:18px;padding:18px 20px;margin-bottom:16px;border:1px solid var(--border);border-radius:12px;background:var(--panel)}.stremioPlanHero h2{margin:8px 0 4px}.stremioPlanGrid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.stremioCard{margin:0}.storefrontCard{grid-column:1/-1}.accessFacts{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:12px}.accessFacts>div{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px;border:1px solid var(--border);border-radius:9px;background:var(--panel2)}.accessFacts span{color:var(--muted)}.advancedCard{margin-top:10px;padding:10px;border:1px solid var(--border);border-radius:9px}.advancedCard summary{cursor:pointer;font-weight:700}.advancedCard .formGroup{margin-top:10px}.stremioSourcesCard{margin-top:14px}.stremioSourceSummary{padding:12px;border:1px solid var(--border);border-radius:9px;background:var(--panel2)}.stremioSourceChoices{display:grid;gap:8px;margin-top:10px}.stremioSourceChoice{display:grid;grid-template-columns:minmax(0,1fr) auto 110px;align-items:center;gap:10px;padding:10px;border:1px solid var(--border);border-radius:9px;background:var(--panel2)}.stremioSourceMain{display:flex;align-items:flex-start;gap:9px;min-width:0}.stremioSourceMain span{display:grid;gap:3px;min-width:0}.stremioSourceMain small{color:var(--muted)}.stremioSourcePriority{display:grid;gap:3px;color:var(--muted);font-size:11px}.stremioSourcePriority .input{min-width:0}.impactPanel{margin-top:14px}.impactChoices{display:grid;gap:8px;margin:10px 0 0;padding:12px;border:1px solid var(--border);border-radius:10px}.impactChoices .choice{display:grid;grid-template-columns:auto 1fr;column-gap:8px;align-items:start;padding:9px;border:1px solid var(--border);border-radius:8px}.impactChoices .choice span{grid-column:2;color:var(--muted);font-size:12px}.stremioSaveBar{position:sticky;bottom:0;z-index:20;display:flex;gap:8px;align-items:center;margin-top:16px;padding:12px;border:1px solid var(--border);border-radius:10px;background:rgba(13,18,24,.96)}@media(max-width:900px){.stremioPlanGrid{grid-template-columns:1fr}.storefrontCard{grid-column:auto}.stremioSourceChoice{grid-template-columns:1fr auto}.stremioSourcePriority{grid-column:1/-1}}@media(max-width:600px){.stremioPlanHero{flex-direction:column}.stremioSaveBar{position:static;flex-wrap:wrap}.stremioSourceChoice{grid-template-columns:1fr}.stremioSourceChoice>.pill{justify-self:start}}</style>`;
  return layout({siteName:runtimeSettings.siteName(),active:'plans',title:p.name,subtitle:'Stremio plan',body,action:'<a class="button secondary" href="/admin/plans">Back to Plans</a>'});
}

async function updateTrackingSnapshots(client,plan,input,impact,scope){
  if(!impact.changed)return 0;
  let result;
  if(impact.restrictive&&scope==='existing'){
    result=await client.query(`UPDATE subscriptions SET stremio_household_network_limit_snapshot=$2,stremio_ip_replacement_policy_snapshot=$3,stremio_ip_replacement_cooldown_minutes_snapshot=$4 WHERE ${activeSubscriptionSql()} RETURNING id`,[plan.id,input.householdLimit,input.replacementPolicy,input.cooldownMinutes]);
  }else if(impact.restrictive){return 0;}
  else{
    result=await client.query(`UPDATE subscriptions SET stremio_household_network_limit_snapshot=$5,stremio_ip_replacement_policy_snapshot=$6,stremio_ip_replacement_cooldown_minutes_snapshot=$7 WHERE ${activeSubscriptionSql(`AND COALESCE(stremio_household_network_limit_snapshot,$2)=$2 AND COALESCE(stremio_ip_replacement_policy_snapshot,$3)=$3 AND COALESCE(stremio_ip_replacement_cooldown_minutes_snapshot,$4)=$4`)} RETURNING id`,[plan.id,impact.oldLimit,impact.oldPolicy,impact.oldCooldown,input.householdLimit,input.replacementPolicy,input.cooldownMinutes]);
  }
  const ids=result.rows.map(row=>String(row.id));
  if(ids.length)await client.query(`DELETE FROM access_network_leases WHERE scope='stremio' AND subject_key=ANY($1::text[])`,[ids]);
  return ids.length;
}

async function save(data,input,scope,actorUserId){
  const impact=householdImpact(data.plan,input);
  return transaction(async client=>{
    const updatedSubscriptions=await updateTrackingSnapshots(client,data.plan,input,impact,scope);
    await client.query(`UPDATE plans SET name=$2,description=$3,billing_interval=$4,duration_days=$5,capacity_limit=$6,active=$7,visible=$8,marketing_features=$9::text[],stremio_household_network_limit=$10,stremio_ip_replacement_policy=$11,stremio_ip_replacement_cooldown_minutes=$12,updated_at=NOW() WHERE id=$1`,[data.plan.id,input.name,input.description,input.billingInterval,input.durationDays,input.capacityLimit,input.active,input.visible,input.marketingFeatures,input.householdLimit,input.replacementPolicy,input.cooldownMinutes]);
    await planPricing.setPrice(client,data.plan.id,{currency:data.price.currency,priceMinor:input.priceMinor,active:true,isDefault:true});
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.stremio_editor.update','plan',$2,$3::jsonb)`,[actorUserId,data.plan.id,JSON.stringify({householdImpact:impact,impactScope:impact.restrictive?(scope||'new_only'):'tracking',updatedSubscriptions,unlimitedStreams:true,unlimitedDevices:true})]);
    return{impact,updatedSubscriptions};
  });
}

function createAdminStremioPlanEditorRouter(){
  const router=express.Router();router.use('/admin/plans',gate,noStore);
  router.get('/admin/plans/:id/edit',async(req,res,next)=>{try{await runtimeSettings.ensureLoaded();const data=await loadData(req.params.id);if(!data)return res.status(404).send('Plan not found');if(String(data.plan.service_type)!=='stremio')return next();return res.send(page(data,req));}catch(error){next(error);}});
  for(const suffix of ['access','delivery','stremio'])router.get(`/admin/plans/:id/${suffix}`,async(req,res,next)=>{try{const data=await loadData(req.params.id);if(!data)return next();if(String(data.plan.service_type)!=='stremio')return next();return res.redirect(302,`/admin/plans/${encodeURIComponent(req.params.id)}/edit`);}catch(error){next(error);}});
  router.post('/admin/plans/:id/stremio-editor',writeLimit,async(req,res,next)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      await runtimeSettings.ensureLoaded();const data=await loadData(req.params.id);if(!data)return res.status(404).send('Plan not found');if(String(data.plan.service_type)!=='stremio')return res.status(400).send('This editor is only available for Stremio plans.');
      const input=parse(req.body||{}),impact=householdImpact(data.plan,input),scope=String(req.body?.impactScope||'');
      if(data.live&&impact.restrictive&&!['new_only','existing'].includes(scope))return res.status(409).send(page(data,req,{input:req.body,impact}));
      const result=await save(data,input,scope,req.session.authUserId);
      const suffix=result.impact.restrictive&&scope==='new_only'?' Existing subscriptions kept their previous household policy.':result.updatedSubscriptions?` ${result.updatedSubscriptions} active subscription${result.updatedSubscriptions===1?' was':'s were'} updated.`:'';
      return res.redirect(`/admin/plans/${encodeURIComponent(data.plan.id)}/edit?message=${encodeURIComponent(`Stremio plan saved.${suffix}`)}`);
    }catch(error){try{const data=await loadData(req.params.id);if(data&&String(data.plan.service_type)==='stremio')return res.status(400).send(page(data,req,{input:req.body,error:error.message}));}catch(renderError){return next(renderError);}return next(error);}
  });
  return router;
}

module.exports={createAdminStremioPlanEditorRouter,loadData,viewValues,parse,householdImpact,updateTrackingSnapshots,save,page};