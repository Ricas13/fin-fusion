'use strict';

const {query}=require('../db');
const planPricing=require('./plan-pricing');
const CURRENCIES=planPricing.CURRENCIES;
function cleanCurrency(value,fallback='GBP'){return planPricing.cleanCurrency(value,fallback)}

async function allPrices(tierId){
  const r=await query(`SELECT id,tier_id,currency,price_minor,active,is_default,created_at,updated_at FROM reseller_tier_prices WHERE tier_id=$1 ORDER BY is_default DESC,currency`,[tierId]);
  return r.rows;
}
async function enabledPrices(tierId){
  const r=await query(`SELECT id,tier_id,currency,price_minor,active,is_default,created_at,updated_at FROM reseller_tier_prices WHERE tier_id=$1 AND active=TRUE ORDER BY is_default DESC,currency`,[tierId]);
  return r.rows;
}
async function resolvePrice(tierId,currency,{allowFallback=true}={}){
  const wanted=cleanCurrency(currency,'GBP');
  const exact=await query(`SELECT * FROM reseller_tier_prices WHERE tier_id=$1 AND active=TRUE AND currency=$2 LIMIT 1`,[tierId,wanted]);
  if(exact.rowCount)return exact.rows[0];
  if(!allowFallback)return null;
  const fallback=await query(`SELECT * FROM reseller_tier_prices WHERE tier_id=$1 AND active=TRUE ORDER BY is_default DESC,created_at LIMIT 1`,[tierId]);
  return fallback.rows[0]||null;
}
async function decorateTiers(tiers,currency,{allowFallback=false}={}){
  const rows=Array.isArray(tiers)?tiers:[];
  if(!rows.length)return[];
  const wanted=cleanCurrency(currency,'GBP'),ids=rows.map(t=>t.id);
  const prices=await query(`SELECT * FROM reseller_tier_prices WHERE tier_id=ANY($1::uuid[]) AND active=TRUE ORDER BY is_default DESC,currency`,[ids]);
  const grouped=new Map();
  for(const price of prices.rows){const key=String(price.tier_id);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(price)}
  const selectedRows=rows.map(tier=>{const variants=grouped.get(String(tier.id))||[],exact=variants.find(x=>String(x.currency).trim()===wanted)||null,selected=exact||(allowFallback?(variants.find(x=>x.is_default)||variants[0]||null):null);return{tier,variants,selected}}).filter(row=>allowFallback||Boolean(row.selected));
  const priceIds=selectedRows.map(x=>x.selected?.id).filter(Boolean);
  const mappings=priceIds.length?await query(`SELECT id,tier_id,tier_price_id,provider,external_id,active,verification_status,verification_error FROM reseller_tier_provider_prices WHERE tier_price_id=ANY($1::uuid[]) AND active=TRUE ORDER BY provider`,[priceIds]):{rows:[]};
  const byPrice=new Map();for(const row of mappings.rows){const key=String(row.tier_price_id);if(!byPrice.has(key))byPrice.set(key,[]);byPrice.get(key).push(row)}
  return selectedRows.map(({tier,variants,selected})=>({...tier,monthly_price_minor:selected?Number(selected.price_minor):Number(tier.monthly_price_minor||0),currency:selected?String(selected.currency).trim():cleanCurrency(tier.currency,'GBP'),tier_price_id:selected?.id||null,prices:variants.map(x=>({id:x.id,currency:String(x.currency).trim(),price_minor:Number(x.price_minor),active:Boolean(x.active),is_default:Boolean(x.is_default)})),provider_prices:selected?byPrice.get(String(selected.id))||[]:[]}));
}
async function setPrice(client,tierId,{currency,priceMinor,active=true,isDefault=false}){
  currency=cleanCurrency(currency,'GBP');priceMinor=Number(priceMinor);
  if(!Number.isInteger(priceMinor)||priceMinor<0)throw new Error(`Invalid ${currency} reseller price.`);
  if(isDefault)await client.query(`UPDATE reseller_tier_prices SET is_default=FALSE,updated_at=NOW() WHERE tier_id=$1`,[tierId]);
  const row=await client.query(`INSERT INTO reseller_tier_prices(tier_id,currency,price_minor,active,is_default) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tier_id,currency) DO UPDATE SET price_minor=EXCLUDED.price_minor,active=EXCLUDED.active,is_default=EXCLUDED.is_default,updated_at=NOW() RETURNING *`,[tierId,currency,priceMinor,Boolean(active),Boolean(isDefault)]);
  if(isDefault)await client.query(`UPDATE reseller_tiers SET monthly_price_minor=$2,currency=$3,updated_at=NOW() WHERE id=$1`,[tierId,priceMinor,currency]);
  return row.rows[0];
}
async function ensureDefault(client,tierId){
  let r=await client.query(`SELECT * FROM reseller_tier_prices WHERE tier_id=$1 AND is_default=TRUE LIMIT 1`,[tierId]);
  if(!r.rowCount)r=await client.query(`UPDATE reseller_tier_prices SET is_default=TRUE,updated_at=NOW() WHERE id=(SELECT id FROM reseller_tier_prices WHERE tier_id=$1 ORDER BY active DESC,created_at LIMIT 1) RETURNING *`,[tierId]);
  const price=r.rows[0];if(price)await client.query(`UPDATE reseller_tiers SET monthly_price_minor=$2,currency=$3,updated_at=NOW() WHERE id=$1`,[tierId,price.price_minor,price.currency]);return price||null;
}
async function providerMapping(tierId,provider,{currency=null,tierPriceId=null,allowFallback=true}={}){
  let price=null;
  if(tierPriceId){const r=await query(`SELECT * FROM reseller_tier_prices WHERE id=$1 AND tier_id=$2 AND active=TRUE`,[tierPriceId,tierId]);price=r.rows[0]||null}
  else price=await resolvePrice(tierId,currency,{allowFallback});
  if(!price)return null;
  const result=await query(`SELECT p.*,t.name AS tier_name,pr.price_minor AS monthly_price_minor,pr.currency,t.seat_limit FROM reseller_tier_provider_prices p JOIN reseller_tier_prices pr ON pr.id=p.tier_price_id AND pr.tier_id=p.tier_id JOIN reseller_tiers t ON t.id=p.tier_id WHERE p.tier_id=$1 AND p.tier_price_id=$2 AND p.provider=$3 AND p.active=TRUE AND pr.active=TRUE AND t.active=TRUE`,[tierId,price.id,provider]);
  return result.rows[0]||null;
}
module.exports={CURRENCIES,cleanCurrency,allPrices,enabledPrices,resolvePrice,decorateTiers,setPrice,ensureDefault,providerMapping};
