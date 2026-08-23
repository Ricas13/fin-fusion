'use strict';

const {query}=require('../db');
const capacity=require('../entitlements/plan-capacity');
const stremio=require('../stremio/foundation');
const pricing=require('./plan-pricing');
const streamVariants=require('./stream-variants');

function availableWindowSql(alias='p'){return `${alias}.active=TRUE AND ${alias}.visible=TRUE AND ${alias}.archived_at IS NULL AND (${alias}.effective_from IS NULL OR ${alias}.effective_from<=NOW()) AND (${alias}.effective_until IS NULL OR ${alias}.effective_until>NOW())`;}
function requestedStreams(value){const n=Number(value);return Number.isInteger(n)&&n>=1&&n<=50?n:null;}
async function baseStreams(planCode){const r=await query(`SELECT streams FROM plans WHERE code=$1 LIMIT 1`,[planCode]);return r.rowCount?Number(r.rows[0].streams||1):null;}
async function capacityFiltered(rows,streams=null){
  if(!rows.length)return rows;
  const required=requestedStreams(streams)||requestedStreams(rows[0].streams)||1;
  const state=await capacity.usage(rows[0].id,undefined,{streams:required});
  return state.soldOut?[]:rows;
}

async function automaticOneTimePlan(planCode,currency,streams=null){
  const requested=requestedStreams(streams),base=await baseStreams(planCode);
  if(requested&&base&&requested!==base){const rows=await streamVariants.resolve(planCode,'coingate',currency,requested,'payment');const filtered=await capacityFiltered(rows,requested);return filtered[0]||null;}
  const result=await query(`
    SELECT p.*,pr.id plan_price_id,pr.price_minor,pr.currency,pr.is_default,
           NULL::uuid stream_variant_id,NULL::uuid provider_mapping_id,NULL::text external_id,
           'payment'::text checkout_mode,'{"automatic":true}'::jsonb AS provider_metadata
    FROM plans p
    JOIN plan_prices pr ON pr.plan_id=p.id AND pr.active=TRUE
    WHERE p.code=$1 AND ${availableWindowSql('p')}
      AND ${capacity.acquisitionSql('p')}
      AND p.audience IN ('direct','both')
      AND pr.currency=$2 AND pr.price_minor>0
      AND ($3::int IS NULL OR p.streams=$3)
    LIMIT 1
  `,[planCode,currency,requested]);
  const rows=await capacityFiltered(result.rows,requested);
  return rows[0]||null;
}

async function baseProviderOptions(planCode,provider,currency,mode=null,streams=null){
  const result=await query(`
    SELECT p.*,pr.id plan_price_id,pr.price_minor,pr.currency,pr.is_default,
           NULL::uuid stream_variant_id,pp.id provider_mapping_id,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata
    FROM plans p
    JOIN plan_prices pr ON pr.plan_id=p.id AND pr.active=TRUE
    JOIN plan_provider_prices pp ON pp.plan_price_id=pr.id AND pp.plan_id=p.id
    WHERE p.code=$1 AND ${availableWindowSql('p')}
      AND ${capacity.acquisitionSql('p')}
      AND p.audience IN ('direct','both')
      AND pp.provider=$2 AND pp.active=TRUE AND pr.currency=$3
      AND ($4::text IS NULL OR pp.checkout_mode=$4)
      AND ($5::int IS NULL OR p.streams=$5)
    ORDER BY CASE pp.checkout_mode WHEN 'payment' THEN 0 ELSE 1 END
  `,[planCode,provider,currency,mode,requestedStreams(streams)]);
  return capacityFiltered(result.rows,streams);
}

async function getProviderOptions(planCode,provider,_currency,streams=null){
  const c=await pricing.platformDefaultCurrency(),requested=requestedStreams(streams),base=await baseStreams(planCode);
  if(provider==='coingate'){
    const plan=await automaticOneTimePlan(planCode,c,requested);
    return plan?[plan]:[];
  }
  if(requested&&base&&requested!==base){const rows=await streamVariants.resolve(planCode,provider,c,requested,null);return capacityFiltered(rows,requested);}
  return baseProviderOptions(planCode,provider,c,null,requested);
}

async function getProviderPlan(planCode,provider,checkoutMode,_currency,streams=null){
  const mode=checkoutMode&&['payment','subscription'].includes(checkoutMode)?checkoutMode:null,c=await pricing.platformDefaultCurrency(),requested=requestedStreams(streams),base=await baseStreams(planCode);
  let plan=null;
  if(provider==='coingate'){
    if(mode==='subscription')return null;
    plan=await automaticOneTimePlan(planCode,c,requested);
  }else if(requested&&base&&requested!==base){
    const rows=await streamVariants.resolve(planCode,provider,c,requested,mode),filtered=await capacityFiltered(rows,requested);plan=filtered[0]||null;
  }else{
    const rows=await baseProviderOptions(planCode,provider,c,mode,requested);plan=rows[0]||null;
  }
  if(plan)stremio.assertAcquirable(plan,{context:`new ${provider} checkout`});return plan;
}

async function getProviderPlanByExternalId(provider,externalId){
  const result=await query(`
    SELECT p.*,pr.id plan_price_id,pr.price_minor,pr.currency,pr.is_default,
           NULL::uuid stream_variant_id,pp.id provider_mapping_id,pp.external_id,pp.checkout_mode,pp.metadata AS provider_metadata,pp.active AS mapping_active
    FROM plan_provider_prices pp
    JOIN plan_prices pr ON pr.id=pp.plan_price_id
    JOIN plans p ON p.id=pr.plan_id AND p.id=pp.plan_id
    WHERE pp.provider=$1 AND pp.external_id=$2 AND p.audience IN ('direct','both')
    ORDER BY pp.updated_at DESC LIMIT 1
  `,[provider,externalId]);
  if(result.rowCount)return result.rows[0];
  return streamVariants.byExternalId(provider,externalId);
}

async function paymentOptionsForPrices(planPriceIds){
  const ids=(planPriceIds||[]).filter(Boolean);if(!ids.length)return new Map();
  const result=await query(`SELECT plan_price_id,id,provider,checkout_mode,external_id,active,verification_status FROM plan_provider_prices WHERE plan_price_id=ANY($1::uuid[]) AND active=TRUE ORDER BY provider,checkout_mode`,[ids]);
  const map=new Map();for(const row of result.rows){const key=String(row.plan_price_id);if(!map.has(key))map.set(key,[]);map.get(key).push({id:row.id,provider:row.provider,checkoutMode:row.checkout_mode,externalId:row.external_id,configured:true,verificationStatus:row.verification_status});}return map;
}

module.exports={getProviderOptions,getProviderPlan,getProviderPlanByExternalId,paymentOptionsForPrices,availableWindowSql,automaticOneTimePlan,capacityFiltered,requestedStreams};
