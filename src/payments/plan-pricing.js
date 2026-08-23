'use strict';

const {query}=require('../db');
const reportingCurrency=require('../platform/reporting-currency');

// These remain the provider/storage currencies CAPTAiNFiN understands. Normal
// portal browsing and checkout use exactly one of them: the platform master
// currency from reporting_currency_v1.
const CURRENCIES=Object.freeze(['GBP','USD','EUR']);
function cleanCurrency(value,fallback='GBP'){
  const c=String(value||'').trim().toUpperCase();
  return CURRENCIES.includes(c)?c:String(fallback||'GBP').toUpperCase();
}
async function platformDefaultCurrency(){
  const cfg=await reportingCurrency.get().catch(()=>({currency:'GBP'}));
  return cleanCurrency(cfg.currency,'GBP');
}
async function userPreferredCurrency(_userId,{fallback=null}={}){
  return cleanCurrency(await platformDefaultCurrency(),fallback||'GBP');
}
async function saveUserPreferredCurrency(_userId,currency,_actorUserId=null){
  const requested=cleanCurrency(currency,'GBP'),current=await platformDefaultCurrency();
  if(requested!==current)throw new Error(`Currency is controlled platform-wide in Settings → Portal currency. The current portal currency is ${current}.`);
  return current;
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
async function resolvePortalPrice(planId){return resolvePrice(planId,await platformDefaultCurrency(),{allowFallback:false});}
async function decoratePlans(plans,_currency,{allowFallback=false}={}){
  const rows=Array.isArray(plans)?plans:[];
  if(!rows.length)return[];
  const wanted=await platformDefaultCurrency(),ids=rows.map(p=>p.id),prices=await query(`SELECT * FROM plan_prices WHERE plan_id=ANY($1::uuid[]) AND active=TRUE ORDER BY is_default DESC,currency`,[ids]);
  const grouped=new Map();for(const price of prices.rows){const key=String(price.plan_id);if(!grouped.has(key))grouped.set(key,[]);grouped.get(key).push(price);}
  const selectedRows=rows.map(plan=>{const variants=grouped.get(String(plan.id))||[],selected=variants.find(x=>x.currency===wanted)||null;return{plan,variants,selected};}).filter(row=>Boolean(row.selected)||allowFallback);
  const priceIds=selectedRows.map(x=>x.selected?.id).filter(Boolean),mappingRows=priceIds.length?await query(`SELECT id,plan_price_id,provider,checkout_mode,external_id,verification_status FROM plan_provider_prices WHERE plan_price_id=ANY($1::uuid[]) AND active=TRUE ORDER BY provider,checkout_mode`,[priceIds]):{rows:[]};
  const mappings=new Map();for(const row of mappingRows.rows){const key=String(row.plan_price_id);if(!mappings.has(key))mappings.set(key,[]);mappings.get(key).push({id:row.id,provider:row.provider,checkoutMode:row.checkout_mode,externalId:row.external_id,configured:true,verificationStatus:row.verification_status});}
  return selectedRows.map(({plan,variants,selected})=>{
    const paymentOptions=selected?[...(mappings.get(String(selected.id))||[])]:[];
    if(selected&&Number(selected.price_minor)>0)paymentOptions.push({id:null,provider:'coingate',checkoutMode:'payment',externalId:null,configured:true,verificationStatus:'automatic'});
    return{...plan,price_minor:selected?Number(selected.price_minor):Number(plan.price_minor||0),currency:selected?.currency||wanted,plan_price_id:selected?.id||null,prices:variants.map(x=>({id:x.id,currency:x.currency,price_minor:Number(x.price_minor),active:Boolean(x.active),is_default:Boolean(x.is_default)})),payment_options:paymentOptions};
  });
}
async function enabledCurrencies(){return[await platformDefaultCurrency()];}
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
module.exports={CURRENCIES,cleanCurrency,platformDefaultCurrency,userPreferredCurrency,saveUserPreferredCurrency,enabledPrices,allPrices,resolvePrice,resolvePortalPrice,decoratePlans,enabledCurrencies,setPrice,ensureDefault};