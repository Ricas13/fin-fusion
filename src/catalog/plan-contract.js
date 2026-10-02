'use strict';

const BILLING_INTERVALS=new Set(['trial','month','6_months','year','custom']);
const SERVICE_TYPES=new Set(['jellyfin','stremio','bundle','emby']);
const SERVER_CLASSES=new Set(['premium','free','custom']);
const ACCESS_MODELS=new Set(['concurrent_streams','household_network']);
const LIBRARY_MODES=new Set(['all','include','exclude']);
const PROVIDERS=new Set(['stripe','paypal']);
const CHECKOUT_MODES=new Set(['payment','subscription']);

function requiredText(value,max,label){
  const clean=String(value??'').trim();
  if(!clean)throw new Error(`${label} is required.`);
  if(clean.length>max)throw new Error(`${label} must be at most ${max} characters.`);
  return clean;
}

function optionalText(value,max,label){
  const clean=String(value??'').trim();
  if(clean.length>max)throw new Error(`${label} must be at most ${max} characters.`);
  return clean;
}

function integer(value,min,max,label,{nullable=false}={}){
  if((value===null||value===undefined||value==='')&&nullable)return null;
  const number=Number(value);
  if(!Number.isInteger(number)||number<min||number>max){
    throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return number;
}

function member(value,allowed,label){
  if(!allowed.has(value))throw new Error(`${label} is not supported.`);
  return value;
}

function currency(value){
  const code=String(value??'').trim().toUpperCase();
  if(!/^[A-Z]{3}$/.test(code))throw new Error('Currency must be a three-letter code.');
  return code;
}

function boolean(value,label){
  if(typeof value!=='boolean')throw new Error(`${label} must be true or false.`);
  return value;
}

function textArray(value,{maxItems=500,maxLength=200,label='Values'}={}){
  if(!Array.isArray(value))throw new Error(`${label} must be a list.`);
  if(value.length>maxItems)throw new Error(`${label} may contain at most ${maxItems} items.`);
  for(const item of value){
    const text=String(item??'').trim();
    if(!text||text.length>maxLength)throw new Error(`${label} contains an invalid item.`);
  }
  return value;
}

function modernCode(value){
  const code=requiredText(value,50,'Plan code').toLowerCase();
  if(!/^[a-z0-9][a-z0-9-]{1,49}$/.test(code)){
    throw new Error('Plan code must use 2–50 lowercase letters, numbers and hyphens.');
  }
  return code;
}

function validateProduct({name,description='',features=[],visible,active}){
  requiredText(name,80,'Plan name');
  optionalText(description,500,'Plan description');
  textArray(features,{maxItems:4,maxLength:90,label:'Homepage features'});
  boolean(visible,'Plan visibility');
  boolean(active,'Plan active state');
}

function validateAvailability({capacityLimit,active=null,visible=null}){
  integer(capacityLimit,0,1000000,'Capacity');
  if(active!==null)boolean(active,'Plan active state');
  if(visible!==null)boolean(visible,'Plan visibility');
}

function validateCommerce({billingInterval,durationDays,currency:currencyCode,priceMinor}){
  member(billingInterval,BILLING_INTERVALS,'Billing interval');
  integer(durationDays,1,3650,'Duration');
  currency(currencyCode);
  integer(priceMinor,0,100000000,'Price');
}

function validateLibraries({mode,names=[]}){
  member(mode,LIBRARY_MODES,'Library access mode');
  textArray(names,{maxItems:500,maxLength:200,label:'Library names'});
  if(mode!=='all'&&!names.length)throw new Error('At least one library name is required for include/exclude mode.');
}

function validateServerSelection({poolMode,servers=[]}){
  if(!['all','selected'].includes(poolMode))throw new Error('Server pool mode is not supported.');
  if(!Array.isArray(servers))throw new Error('Server selection must be a list.');
  if(poolMode==='selected'&&!servers.length)throw new Error('Choose at least one server for a selected server pool.');
  const seen=new Set();
  for(const server of servers){
    const id=requiredText(server?.id,120,'Server ID');
    if(seen.has(id))throw new Error('Server selection contains a duplicate server.');
    seen.add(id);
    integer(server?.weight??100,1,10000,'Server placement weight');
  }
}

function validateStremioAccess({householdLimit,leaseMinutes}){
  integer(householdLimit,1,10,'Stremio household connections');
  integer(leaseMinutes,15,1440,'Stremio household lease');
}

function validateCreatePlan(plan){
  modernCode(plan.code);
  requiredText(plan.name,80,'Plan name');
  optionalText(plan.description,500,'Plan description');
  member(plan.serviceType,new Set(['jellyfin','stremio']),'Service type');
  if(plan.audience!=='direct')throw new Error('New plans must use the direct audience.');
  validateCommerce({
    billingInterval:plan.billing,
    durationDays:plan.duration,
    currency:plan.currency,
    priceMinor:plan.priceMinor
  });
  validateAvailability({capacityLimit:plan.capacityLimit,active:plan.active,visible:plan.visible});
  member(plan.serverClass,SERVER_CLASSES,'Server class');
  member(plan.jellyfinAccessModel,ACCESS_MODELS,'Jellyfin access model');
  integer(plan.jellyfinHouseholdNetworkLimit,1,10,'Jellyfin household connections');
  integer(plan.jellyfinHouseholdLeaseMinutes,15,1440,'Jellyfin household lease');
  integer(plan.stremioHouseholdNetworkLimit,1,10,'Stremio household connections');
  integer(plan.stremioHouseholdLeaseMinutes,15,1440,'Stremio household lease');
  integer(plan.streams,0,50,'Concurrent streams');
  validateLibraries({mode:plan.libraryMode,names:plan.libraries||[]});
  return plan;
}

function validateImportedPlan(plan){
  requiredText(plan.code,80,'Plan code');
  requiredText(plan.name,160,'Plan name');
  optionalText(plan.description,1000,'Plan description');
  if(plan.service_type!==undefined)member(plan.service_type,SERVICE_TYPES,'Service type');
  member(plan.billing_interval,BILLING_INTERVALS,'Billing interval');
  integer(plan.duration_days,1,3650,'Duration',{nullable:true});
  integer(plan.price_minor,0,100000000,'Price');
  currency(plan.currency);
  if(plan.capacity_limit!==undefined&&plan.capacity_limit!==null)integer(plan.capacity_limit,0,1000000,'Capacity');
  if(plan.server_class!==undefined)member(plan.server_class,SERVER_CLASSES,'Server class');
  if(plan.jellyfin_access_model!==undefined)member(plan.jellyfin_access_model,ACCESS_MODELS,'Jellyfin access model');
  if(plan.streams!==undefined)integer(plan.streams,0,50,'Concurrent streams',{nullable:true});
  if(plan.library_access_mode!==undefined){
    validateLibraries({mode:plan.library_access_mode,names:Array.isArray(plan.library_names)?plan.library_names:[]});
  }
  return plan;
}

function validateProviderMapping({provider,mode,externalId=null}){
  member(provider,PROVIDERS,'Payment provider');
  member(mode,CHECKOUT_MODES,'Checkout mode');
  const id=optionalText(externalId,200,'External provider ID');
  if(mode==='subscription'&&!id)throw new Error('Subscription payment mappings require an external provider ID.');
  return {provider,mode,externalId:id||null};
}

module.exports={
  BILLING_INTERVALS,
  SERVICE_TYPES,
  SERVER_CLASSES,
  ACCESS_MODELS,
  LIBRARY_MODES,
  validateProduct,
  validateAvailability,
  validateCommerce,
  validateLibraries,
  validateServerSelection,
  validateStremioAccess,
  validateCreatePlan,
  validateImportedPlan,
  validateProviderMapping
};
