'use strict';

const {query,transaction}=require('../db');
const {keyFromEnv}=require('../security/purpose-crypto');

const KEY='stremio_runtime_v1';
let cache=null;

function legacyEnabled(){return String(process.env.STREMIO_RUNTIME_ENABLED||'').toLowerCase()==='true';}
function keyConfigured(){try{keyFromEnv('STREMIO_JELLYFIN_TOKEN_KEY');return true;}catch(_){return false;}}
function snapshot(){return cache?{...cache}:{enabled:false,source:'unloaded'};}

async function reload(){
  const result=await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1 LIMIT 1',[KEY]);
  if(result.rowCount){
    const value=result.rows[0]?.setting_value||{};
    cache={enabled:value.enabled===true,source:'database'};
  }else{
    const inherited=legacyEnabled();
    cache={enabled:inherited,source:inherited?'legacy_env':'default'};
  }
  return snapshot();
}
async function ensureLoaded(){return cache?snapshot():reload();}
function enabled(){return cache?.enabled===true;}
function source(){return cache?.source||'unloaded';}

async function prerequisites(){
  const [servers,indexes]=await Promise.all([
    query(`SELECT COUNT(*)::int n
      FROM jellyfin_servers
      WHERE enabled=TRUE AND stremio_enabled=TRUE AND public_url IS NOT NULL
        AND COALESCE(placement_mode,'active')='active'
        AND health_status IN ('healthy','degraded')`),
    query(`SELECT COUNT(*)::int n
      FROM stremio_media_index_state s
      JOIN jellyfin_servers j ON j.id=s.server_id
      WHERE j.enabled=TRUE AND j.stremio_enabled=TRUE AND j.public_url IS NOT NULL
        AND COALESCE(j.placement_mode,'active')='active'
        AND j.health_status IN ('healthy','degraded')
        AND s.status='ready' AND s.item_count>0`)
  ]);
  const result={
    keyConfigured:keyConfigured(),
    eligibleServers:Number(servers.rows[0]?.n||0),
    readyIndexes:Number(indexes.rows[0]?.n||0)
  };
  return {...result,ready:result.keyConfigured&&result.eligibleServers>0&&result.readyIndexes>0};
}

async function setEnabled(value,actorUserId=null){
  const next=value===true;
  const checks=await prerequisites();
  if(next&&!checks.keyConfigured)throw new Error('Configure STREMIO_JELLYFIN_TOKEN_KEY before enabling the Stremio runtime.');
  if(next&&checks.eligibleServers<1)throw new Error('Enable at least one healthy Stremio delivery server with a public playback URL before enabling the runtime.');
  if(next&&checks.readyIndexes<1)throw new Error('Build at least one ready, non-empty Stremio media index before enabling the runtime.');
  await transaction(async client=>{
    await client.query(`INSERT INTO platform_settings(setting_key,setting_value)
      VALUES($1,$2::jsonb)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`,[KEY,JSON.stringify({enabled:next})]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.runtime.update','platform_setting',$2,$3::jsonb)`,[actorUserId,KEY,JSON.stringify({enabled:next,eligibleServers:checks.eligibleServers,readyIndexes:checks.readyIndexes,keyConfigured:checks.keyConfigured})]);
  });
  cache={enabled:next,source:'database'};
  return snapshot();
}

module.exports={KEY,reload,ensureLoaded,enabled,source,snapshot,legacyEnabled,keyConfigured,prerequisites,setEnabled};
