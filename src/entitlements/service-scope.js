'use strict';

const serviceCatalog=require('../catalog/service-catalog');
const SERVICE_TYPES=serviceCatalog.SERVICE_TYPES;

function serviceType(value){return serviceCatalog.serviceType(value);}
function capabilities(value){return new Set(serviceCatalog.capabilities(value));}
function overlaps(left,right){const a=capabilities(left),b=capabilities(right);return [...a].some(value=>b.has(value));}
function label(value){
  const type=serviceType(value);
  if(type==='stremio')return'Stremio';
  if(type==='emby')return'Emby Share';
  if(type==='bundle')return'Jellyfin + Stremio';
  return'Premium Server';
}
function isFreeTier(value){return serviceType(value)==='jellyfin'&&(value?.is_free_tier===true||String(value?.is_free_tier||'').toLowerCase()==='true');}

module.exports={SERVICE_TYPES,serviceType,capabilities,overlaps,label,isFreeTier};
