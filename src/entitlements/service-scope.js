'use strict';

const SERVICE_TYPES=Object.freeze(['jellyfin','stremio','bundle']);

function serviceType(value){
  const raw=typeof value==='object'&&value!==null
    ? (value.service_type_snapshot||value.service_type||value.serviceType||'jellyfin')
    : value;
  const normalized=String(raw||'jellyfin').trim().toLowerCase();
  return SERVICE_TYPES.includes(normalized)?normalized:'jellyfin';
}
function capabilities(value){
  const type=serviceType(value);
  if(type==='bundle')return new Set(['jellyfin','stremio']);
  return new Set([type]);
}
function overlaps(left,right){
  const a=capabilities(left),b=capabilities(right);
  for(const capability of a)if(b.has(capability))return true;
  return false;
}
function label(value){
  const type=serviceType(value);
  if(type==='stremio')return 'Stremio';
  if(type==='bundle')return 'Jellyfin + Stremio';
  return 'Premium Server';
}
function isFreeTier(value){return value?.is_free_tier===true||String(value?.is_free_tier||'').toLowerCase()==='true';}

module.exports={SERVICE_TYPES,serviceType,capabilities,overlaps,label,isFreeTier};
