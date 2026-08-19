'use strict';

const {query,transaction}=require('../db');
const CURRENCIES=Object.freeze(['GBP','USD','EUR']);
const KEY='reporting_currency_v1';
let refreshPromise=null;
function cleanCurrency(value){const c=String(value||'GBP').trim().toUpperCase();return CURRENCIES.includes(c)?c:'GBP';}
function assertCurrency(value){const c=String(value||'').trim().toUpperCase();if(!CURRENCIES.includes(c))throw new Error('Portal currency must be GBP, USD or EUR.');return c;}
function defaults(){return{currency:'GBP',rates:{GBP:1,USD:1.27,EUR:1.17},updatedAt:null,source:'fallback'};}
function normalize(value={}){const d=defaults(),rates={...d.rates,...(value.rates||{})};for(const c of CURRENCIES){const n=Number(rates[c]);rates[c]=Number.isFinite(n)&&n>0?n:d.rates[c];}rates.GBP=1;return{currency:cleanCurrency(value.currency),rates,updatedAt:value.updatedAt||null,source:value.source||'stored'};}
async function get(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[KEY]);return normalize(r.rows[0]?.setting_value||{});}
async function getForUser(_userId){const state=await get();return{...state,platformCurrency:state.currency,currency:state.currency,preferredCurrency:null,masterCurrency:true};}
function convertMinor(minor,from,to,state){from=cleanCurrency(from);to=cleanCurrency(to);const cfg=normalize(state),amount=Number(minor||0);if(from===to)return Math.round(amount);const gbp=amount/Number(cfg.rates[from]||1);return Math.round(gbp*Number(cfg.rates[to]||1));}

// The catalogue has one commercial amount per paid plan. Changing the portal
// currency changes the denomination, not the numeric price: 6.00 GBP becomes
// 6.00 USD/EUR. Historical subscriptions/orders/payment events keep their own
// immutable snapshots, so this only changes future catalogue/checkout state.
//
// The canonical free tier is a deliberate schema exception: its compatibility
// price rows must remain active and zero in every supported storage currency.
// Only the selected portal currency is exposed by live storefront APIs.
async function switchCatalogueCurrency(client,currency){
  const plans=(await client.query(`SELECT id,price_minor,currency,is_free_tier FROM plans WHERE archived_at IS NULL ORDER BY id FOR UPDATE`)).rows;
  if(!plans.length)return{plans:0,invalidatedMappings:0};
  const ids=plans.map(row=>row.id);
  const existing=(await client.query(`SELECT id,plan_id,price_minor FROM plan_prices WHERE currency=$1 AND plan_id=ANY($2::uuid[])`,[currency,ids])).rows;
  const priorByPlan=new Map(existing.map(row=>[String(row.plan_id),row]));

  // Paid plans expose one active currency. Free-tier compatibility rows stay
  // active at zero because protect_canonical_free_tier_price enforces that
  // invariant; their non-master variants are simply never selected by the UI.
  await client.query(`
    UPDATE plan_prices pr
       SET active=CASE WHEN p.is_free_tier THEN TRUE ELSE FALSE END,
           is_default=FALSE,
           updated_at=NOW()
      FROM plans p
     WHERE pr.plan_id=p.id AND pr.plan_id=ANY($1::uuid[])
  `,[ids]);
  await client.query(`UPDATE plan_provider_prices pp SET active=FALSE,updated_at=NOW() FROM plan_prices pr WHERE pp.plan_price_id=pr.id AND pr.plan_id=ANY($1::uuid[]) AND pr.currency<>$2`,[ids,currency]);

  let invalidatedMappings=0;
  for(const plan of plans){
    const amount=plan.is_free_tier?0:Number(plan.price_minor||0),prior=priorByPlan.get(String(plan.id));
    const target=await client.query(`INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default) VALUES($1,$2,$3,TRUE,TRUE) ON CONFLICT(plan_id,currency) DO UPDATE SET price_minor=EXCLUDED.price_minor,active=TRUE,is_default=TRUE,updated_at=NOW() RETURNING id`,[plan.id,currency,amount]);
    if(prior&&Number(prior.price_minor)!==amount){
      const changed=await client.query(`UPDATE plan_provider_prices SET active=FALSE,verification_status='unverified',verification_error='Portal currency switch changed the catalogue amount; re-verification required.',updated_at=NOW() WHERE plan_price_id=$1 AND active=TRUE`,[target.rows[0].id]);
      invalidatedMappings+=Number(changed.rowCount||0);
    }
  }
  await client.query(`UPDATE plans SET currency=$1,updated_at=NOW() WHERE id=ANY($2::uuid[])`,[currency,ids]);
  return{plans:plans.length,invalidatedMappings};
}

async function saveCurrency(currency,actorUserId=null){
  currency=assertCurrency(currency);
  return transaction(async client=>{
    const r=await client.query('SELECT setting_value FROM platform_settings WHERE setting_key=$1 FOR UPDATE',[KEY]),value=normalize(r.rows[0]?.setting_value||{}),previous=value.currency;
    // Always reconcile the catalogue, even when the selected currency did not
    // change. That makes the first save after upgrading collapse any legacy
    // paid multi-currency catalogue into the configured master currency safely.
    const catalogue=await switchCatalogueCurrency(client,currency);
    value.currency=currency;
    await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[KEY,JSON.stringify(value),actorUserId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.portal_currency.update','platform_setting',$2,$3::jsonb)`,[actorUserId,KEY,JSON.stringify({previousCurrency:previous,currency,pricingMode:'same_numeric_amount',cataloguePlans:catalogue.plans,invalidatedMappings:catalogue.invalidatedMappings})]);
    return{...value,catalogue};
  });
}
async function saveUserCurrency(_userId,currency,_actorUserId=null){const requested=assertCurrency(currency),state=await get();if(requested!==state.currency)throw new Error(`Currency is controlled platform-wide in Settings → Portal currency. The current portal currency is ${state.currency}.`);return state.currency;}
async function clearUserCurrency(_userId,_actorUserId=null){return null;}
async function refreshRates({maxAgeHours=6}={}){
  const current=await get(),age=current.updatedAt?Date.now()-new Date(current.updatedAt).getTime():Infinity;
  if(age<Math.max(1,maxAgeHours)*3600000)return current;
  if(refreshPromise)return refreshPromise;
  refreshPromise=(async()=>{
    const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),3500);
    try{
      const response=await fetch('https://api.frankfurter.app/latest?from=GBP&to=USD,EUR',{headers:{Accept:'application/json'},redirect:'error',signal:controller.signal});
      if(!response.ok)throw new Error(`FX HTTP ${response.status}`);const body=await response.json(),usd=Number(body?.rates?.USD),eur=Number(body?.rates?.EUR);if(!Number.isFinite(usd)||usd<=0||!Number.isFinite(eur)||eur<=0)throw new Error('FX response missing GBP rates');
      const value={...current,rates:{GBP:1,USD:usd,EUR:eur},updatedAt:new Date().toISOString(),source:'frankfurter'};
      await query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[KEY,JSON.stringify(value)]);
      return value;
    }catch(error){console.warn('Historical FX refresh failed; using stored rates:',error.message);return current;}finally{clearTimeout(timer);refreshPromise=null;}
  })();return refreshPromise;
}
module.exports={CURRENCIES,KEY,get,getForUser,saveCurrency,saveUserCurrency,clearUserCurrency,refreshRates,convertMinor,cleanCurrency,assertCurrency,normalize,switchCatalogueCurrency};
