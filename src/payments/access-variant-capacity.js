'use strict';

const planCapacity=require('../entitlements/plan-capacity');
const accessVariants=require('./stream-variants');

function fallbackCapacity(plan){
  return{
    limit:plan?.capacity_limit??null,
    used:0,
    reserved:0,
    remaining:plan?.capacity_limit??null,
    soldOut:false,
    label:'Available',
    kind:'available'
  };
}

function variantKind(plan,variant){return variant?.variant_kind||plan?.access_variant_kind||accessVariants.variantKind(plan)||'streams';}
function variantQuantity(plan,variant){const kind=variantKind(plan,variant),raw=variant?.access_quantity??variant?.quantity??(kind==='households'?variant?.stremio_household_network_limit:variant?.streams),n=Number(raw);return Number.isInteger(n)&&n>0?n:accessVariants.baseQuantity(plan);}
function capacityOptions(plan,variant){const kind=variantKind(plan,variant),quantity=variantQuantity(plan,variant);return kind==='households'?{households:quantity}:{streams:quantity};}
function preferredVariant(plan,variants){const list=Array.isArray(variants)?variants:[],base=accessVariants.baseQuantity(plan),available=list.filter(v=>!v?.capacity?.soldOut);return available.find(v=>variantQuantity(plan,v)===base)||available[0]||list.find(v=>variantQuantity(plan,v)===base)||list[0]||null;}
function familyCapacity(plan,baseCapacity,variants){const list=Array.isArray(variants)?variants:[];if(!list.length)return baseCapacity;const available=list.filter(v=>!v?.capacity?.soldOut),preferred=preferredVariant(plan,list),representative=preferred?.capacity||baseCapacity||fallbackCapacity(plan),soldOut=available.length===0;return{...representative,soldOut,label:soldOut?(representative?.soldOut?representative.label:'Currently full'):(representative?.label||'Available'),kind:soldOut?(representative?.soldOut?representative.kind:'sold'):(representative?.kind||'available'),familyVariantQuantity:preferred?variantQuantity(plan,preferred):accessVariants.baseQuantity(plan)};}
async function decoratePlan(plan,{usage=planCapacity.usage}={}){
  const baseCapacity=await usage(plan.id).catch(()=>fallbackCapacity(plan)),raw=Array.isArray(plan.access_variants)?plan.access_variants:[];
  if(!raw.length)return{...plan,capacity:baseCapacity,preferred_access_variant:null};
  const variants=await Promise.all(raw.map(async variant=>({...variant,capacity:await usage(plan.id,undefined,capacityOptions(plan,variant)).catch(()=>baseCapacity)}))),preferred=preferredVariant(plan,variants);
  return{...plan,base_capacity:baseCapacity,capacity:familyCapacity(plan,baseCapacity,variants),access_variants:variants,preferred_access_variant:preferred};
}
async function decoratePlans(plans,options={}){return Promise.all((Array.isArray(plans)?plans:[]).map(plan=>decoratePlan(plan,options)));}
module.exports={fallbackCapacity,variantKind,variantQuantity,capacityOptions,preferredVariant,familyCapacity,decoratePlan,decoratePlans};
