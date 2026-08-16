'use strict';

const {query}=require('../db');
const reportingCurrency=require('../platform/reporting-currency');

const CURRENCIES=Object.freeze(['GBP','USD','EUR']);
function cleanCurrency(value,fallback='GBP'){
  const c=String(value||'').trim().toUpperCase();
  return CURRENCIES.includes(c)?c:String(fallback||'GBP').toUpperCase();
}
async function platformDefaultCurrency(){
  const cfg=await reportingCurrency.get().catch(()=>({currency:'GBP'}));
  return cleanCurrency(cfg.currency,'GBP');
}
async function userPreferredCurrency(userId,{fallback=null}={}){
  if(userId){
    const r=await query(`SELECT preferred_currency FROM app_users WHERE id=$1`,[userId]);
    const value=r.rows[0]?.preferred_currency;
    if(value)return cleanCurrency(value,'GBP');
  }
  return cleanCurrency(fallback||await platformDefaultCurrency(),'GBP');
}
async function saveUserPreferredCurrency(userId,currency,actorUserId=userId){
  currency=cleanCurrency(currency,'GBP');
  const r=await query(`UPDATE app_users SET preferred_currency=$2,updated_at=NOW() WHERE id=$1 RETURNING preferred_currency`,[userId,currency]);
  if(!r.rowCount)throw new Error('User account not found.');
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'user.currency.preference','app_user',$2,$3::jsonb)`,[actorUserId,String(userId),JSON.stringify({currency})]);
  return currency;
}
async function enabledPrices(planId){
  const r=await query(`SELECT id,plan_id,currency,price_minor,active,is_default,created_at,updated_at FROM plan_prices WHERE plan_id=$1 AND active=TRUE ORDER BY is_default DESC,currency`,[planId]);
  return r.rows;
}
async function allPrices(planId){
  const r=await query(`SELECT id,plan_id,currency,price_minor,active,is_default,created_at,updated_at FROM plan_prices WHERE plan_id=$1 ORDER BY is_default DESC,currency`,[planId]);
  return r.rows;
}
async function resolvePrice(planId,currency,{allowFallback=true}={}){
  const wanted=cleanCurrency(currency,'GBP');
  const r=await query(`SELECT * FROM plan_prices WHERE plan_id=$1 AND active=TRUE AND currency=$2 LIMIT 1`,[planId,wanted]);
  if(r.rowCount)return r.rows[0];
  if(!allowFallback)return null;
  const fallback=await query(`SELECT * FROM plan_prices WHERE plan_id=$1 AND active=TRUE ORDER BY is_default DESC,created_at LIMIT 1`,[planId]);
  return fallback.rows[0]||null;
}
async function decoratePlans(plans,currency){
  const rows=Array.isArray(plans)?plans:[];
  if(!rows.length)return[];
  const wanted=cleanCurrency(currency,'GBP'),ids=rows.map(p=>p.id),prices=await query(`SELECT * FROM plan_prices WHERE plan_id=ANY($1::uuid[]) AND active=TRUE ORDER BY is_default DESC,currency`,[ids]);
  const grouped=new Map();for(const price of prices.rows){const key=String(price.plan_id);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(price);}
  return rows.map(plan=>{
    const variants=grouped.get(String(plan.id))||[];
    const selected=variants.find(x=>x.currency===wanted)||variants.find(x=>x.is_default)||variants[0]||null;
    return {...plan,price_minor:selected?Number(selected.price_minor):Number(plan.price_minor||0),currency:selected?.currency||cleanCurrency(plan.currency,'GBP'),plan_price_id:selected?.id||null,prices:variants.map(x=>({id:x.id,currency:x.currency,price_minor:Number(x.price_minor),active:Boolean(x.active),is_default:Boolean(x.is_default)}))};
  });
}
async function enabledCurrencies({publicOnly=true}={}){
  const r=await query(`SELECT DISTINCT pr.currency FROM plan_prices pr JOIN plans p ON p.id=pr.plan_id WHERE pr.active=TRUE ${publicOnly?"AND p.active=TRUE AND p.visible=TRUE AND p.archived_at IS NULL AND p.audience IN ('direct','both')":''} ORDER BY pr.currency`);
  const currencies=r.rows.map(x=>cleanCurrency(x.currency,'GBP')).filter((x,i,a)=>a.indexOf(x)===i);
  return currencies.length?currencies:['GBP'];
}
async function setPrice(client,planId,{currency,priceMinor,active=true,isDefault=false}){
  currency=cleanCurrency(currency,'GBP');priceMinor=Number(priceMinor);
  if(!Number.isInteger(priceMinor)||priceMinor<0)throw new Error(`Invalid ${currency} price.`);
  if(isDefault)await client.query(`UPDATE plan_prices SET is_default=FALSE,updated_at=NOW() WHERE plan_id=$1`,[planId]);
  const row=await client.query(`INSERT INTO plan_prices(plan_id,currency,price_minor,active,is_default) VALUES($1,$2,$3,$4,$5) ON CONFLICT(plan_id,currency) DO UPDATE SET price_minor=EXCLUDED.price_minor,active=EXCLUDED.active,is_default=EXCLUDED.is_default,updated_at=NOW() RETURNING *`,[planId,currency,priceMinor,Boolean(active),Boolean(isDefault)]);
  if(isDefault){await client.query(`UPDATE plans SET price_minor=$2,currency=$3,updated_at=NOW() WHERE id=$1`,[planId,priceMinor,currency]);}
  return row.rows[0];
}
async function ensureDefault(client,planId){
  let r=await client.query(`SELECT * FROM plan_prices WHERE plan_id=$1 AND is_default=TRUE LIMIT 1`,[planId]);
  if(!r.rowCount){r=await client.query(`UPDATE plan_prices SET is_default=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM plan_prices WHERE plan_id=$1 ORDER BY active DESC,created_at LIMIT 1) RETURNING *`,[planId]);}
  const price=r.rows[0];if(price)await client.query(`UPDATE plans SET price_minor=$2,currency=$3,updated_at=NOW() WHERE id=$1`,[planId,price.price_minor,price.currency]);return price||null;
}
module.exports={CURRENCIES,cleanCurrency,platformDefaultCurrency,userPreferredCurrency,saveUserPreferredCurrency,enabledPrices,allPrices,resolvePrice,decoratePlans,enabledCurrencies,setPrice,ensureDefault};
