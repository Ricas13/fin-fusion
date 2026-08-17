'use strict';

const {query,transaction}=require('../db');
const {keyFromEnv}=require('../security/purpose-crypto');

const KEY='stremio_runtime_v1';
let cache=null;

function legacyEnabled(){return String(process.env.STREMIO_RUNTIME_ENABLED||'').toLowerCase()==='true';}
function managedKeyConfigured(){try{keyFromEnv('STREMIO_JELLYFIN_TOKEN_KEY');return true;}catch(_){return false;}}
function sourceKeyConfigured(){try{keyFromEnv('JELLYFIN_ENCRYPTION_KEY');return true;}catch(_){return false;}}
function snapshot(){if(cache)return{...cache};const inherited=legacyEnabled();return{enabled:inherited,source:inherited?'legacy_env':'unloaded'};}
async function reload(){const result=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1 LIMIT 1',[KEY]);if(result.rowCount){const value=result.rows[0]?.setting_value||{};cache={enabled:value.enabled===true,source:'database'};}else{const inherited=legacyEnabled();cache={enabled:inherited,source:inherited?'legacy_env':'default'};}return snapshot();}
async function ensureLoaded(){return cache?snapshot():reload();}
function enabled(){return cache?cache.enabled===true:legacyEnabled();}
function source(){return snapshot().source;}

async function prerequisites(){
  const [managedServers,managedIndexes,externalSources,externalIndexes]=await Promise.all([
    query(`SELECT COUNT(*)::int n FROM jellyfin_servers WHERE enabled=TRUE AND stremio_enabled=TRUE AND public_url IS NOT NULL AND COALESCE(placement_mode,'active')='active' AND health_status IN ('healthy','degraded')`),
    query(`SELECT COUNT(*)::int n FROM stremio_media_index_state i JOIN jellyfin_servers j ON j.id=i.server_id WHERE j.enabled=TRUE AND j.stremio_enabled=TRUE AND j.public_url IS NOT NULL AND COALESCE(j.placement_mode,'active')='active' AND j.health_status IN ('healthy','degraded') AND i.status='ready' AND i.item_count>0`),
    query(`SELECT COUNT(*)::int n FROM stremio_sources s WHERE s.enabled=TRUE AND s.auth_state='connected' AND EXISTS(SELECT 1 FROM stremio_source_libraries l WHERE l.source_id=s.id AND l.selected=TRUE AND l.available=TRUE)`),
    query(`SELECT COUNT(*)::int n FROM stremio_source_index_state i JOIN stremio_sources s ON s.id=i.source_id WHERE s.enabled=TRUE AND s.auth_state='connected' AND i.status='ready' AND i.item_count>0 AND EXISTS(SELECT 1 FROM stremio_source_libraries l WHERE l.source_id=s.id AND l.selected=TRUE AND l.available=TRUE)`)
  ]);
  const managedKey=managedKeyConfigured(),sourceKey=sourceKeyConfigured();
  const managedServerCount=Number(managedServers.rows[0]?.n||0),managedIndexCount=Number(managedIndexes.rows[0]?.n||0),externalSourceCount=sourceKey?Number(externalSources.rows[0]?.n||0):0,externalIndexCount=sourceKey?Number(externalIndexes.rows[0]?.n||0):0;
  const usableManagedServers=managedKey?managedServerCount:0,usableManagedIndexes=managedKey?managedIndexCount:0;
  const eligibleSources=externalSourceCount+usableManagedServers,readyIndexes=externalIndexCount+usableManagedIndexes;
  return{managedKeyConfigured:managedKey,sourceKeyConfigured:sourceKey,keyConfigured:managedKey,managedServers:managedServerCount,managedReadyIndexes:managedIndexCount,externalSources:externalSourceCount,externalReadyIndexes:externalIndexCount,eligibleServers:usableManagedServers,eligibleSources,readyIndexes,ready:eligibleSources>0&&readyIndexes>0};
}

async function setEnabled(value,actorUserId=null){
  const next=value===true,checks=await prerequisites();
  if(next&&checks.eligibleSources<1)throw new Error('Connect at least one usable Stremio source and select its libraries before enabling the runtime.');
  if(next&&checks.readyIndexes<1)throw new Error('Build at least one ready, non-empty Stremio source index before enabling the runtime.');
  await transaction(async client=>{
    await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES($1,$2::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[KEY,JSON.stringify({enabled:next})]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.stremio.runtime.update','platform_setting',$2,$3::jsonb)`,[actorUserId,KEY,JSON.stringify({enabled:next,eligibleSources:checks.eligibleSources,readyIndexes:checks.readyIndexes,externalSources:checks.externalSources,managedServers:checks.managedServers})]);
  });
  cache={enabled:next,source:'database'};return snapshot();
}

module.exports={KEY,reload,ensureLoaded,enabled,source,snapshot,legacyEnabled,managedKeyConfigured,sourceKeyConfigured,keyConfigured:managedKeyConfigured,prerequisites,setEnabled};
