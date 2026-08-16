'use strict';

const {query,transaction}=require('../db');
const CURRENCIES=Object.freeze(['GBP','USD','EUR']);
const KEY='reporting_currency_v1';
let refreshPromise=null;
function cleanCurrency(value){const c=String(value||'GBP').trim().toUpperCase();return CURRENCIES.includes(c)?c:'GBP';}
function defaults(){return{currency:'GBP',rates:{GBP:1,USD:1.27,EUR:1.17},updatedAt:null,source:'fallback'};}
function normalize(value={}){const d=defaults(),rates={...d.rates,...(value.rates||{})};for(const c of CURRENCIES){const n=Number(rates[c]);rates[c]=Number.isFinite(n)&&n>0?n:d.rates[c];}rates.GBP=1;return{currency:cleanCurrency(value.currency),rates,updatedAt:value.updatedAt||null,source:value.source||'stored'};}
async function get(){const r=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1',[KEY]);return normalize(r.rows[0]?.setting_value||{});}
async function getForUser(userId){const state=await get(),result=userId?await query('SELECT preferred_currency FROM app_users WHERE id=$1',[userId]):{rows:[]},preferred=result.rows[0]?.preferred_currency?cleanCurrency(result.rows[0].preferred_currency):null;return{...state,platformCurrency:state.currency,currency:preferred||state.currency,preferredCurrency:preferred};}
function convertMinor(minor,from,to,state){from=cleanCurrency(from);to=cleanCurrency(to);const cfg=normalize(state),amount=Number(minor||0);if(from===to)return Math.round(amount);const gbp=amount/Number(cfg.rates[from]||1);return Math.round(gbp*Number(cfg.rates[to]||1));}
async function saveCurrency(currency,actorUserId=null){currency=cleanCurrency(currency);return transaction(async client=>{const r=await client.query('SELECT setting_value FROM platform_settings WHERE setting_key=$1 FOR UPDATE',[KEY]),value=normalize(r.rows[0]?.setting_value||{});value.currency=currency;await client.query(`INSERT INTO platform_settings(setting_key,setting_value,updated_by) VALUES($1,$2::jsonb,$3) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,[KEY,JSON.stringify(value),actorUserId]);await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.reporting_currency.update','platform_setting',$2,$3::jsonb)`,[actorUserId,KEY,JSON.stringify({currency})]);return value;});}
async function saveUserCurrency(userId,currency,actorUserId=userId){currency=cleanCurrency(currency);return transaction(async client=>{const updated=await client.query(`UPDATE app_users SET preferred_currency=$2,updated_at=NOW() WHERE id=$1 RETURNING preferred_currency`,[userId,currency]);if(!updated.rowCount)throw new Error('User account not found.');await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'user.reporting_currency.update','app_user',$2,$3::jsonb)`,[actorUserId,String(userId),JSON.stringify({currency})]);return currency;});}
async function clearUserCurrency(userId,actorUserId=userId){return transaction(async client=>{const updated=await client.query(`UPDATE app_users SET preferred_currency=NULL,updated_at=NOW() WHERE id=$1 RETURNING id`,[userId]);if(!updated.rowCount)throw new Error('User account not found.');await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'user.reporting_currency.update','app_user',$2,$3::jsonb)`,[actorUserId,String(userId),JSON.stringify({currency:null,mode:'platform_default'})]);return null;});}
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
    }catch(error){console.warn('Reporting FX refresh failed; using stored rates:',error.message);return current;}finally{clearTimeout(timer);refreshPromise=null;}
  })();return refreshPromise;
}
module.exports={CURRENCIES,KEY,get,getForUser,saveCurrency,saveUserCurrency,clearUserCurrency,refreshRates,convertMinor,cleanCurrency,normalize};
