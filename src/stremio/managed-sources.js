'use strict';

const {query,transaction}=require('../db');
const registry=require('../jellyfin/registry');

function priority(value){
  const parsed=Number.parseInt(value,10);
  if(!Number.isInteger(parsed)||parsed<1||parsed>10000)throw new Error('Stremio source priority must be between 1 and 10000.');
  return parsed;
}

async function list(){
  const result=await query(`SELECT js.id,js.name,js.slug,js.server_class,js.base_url,js.public_url,
      js.enabled,js.health_status,js.stremio_enabled,js.stremio_priority,
      (js.api_key_encrypted IS NOT NULL) api_configured,
      COUNT(DISTINCT sma.id) FILTER(WHERE sma.status='active')::int managed_stremio_accounts,
      MAX(sma.last_playback_info_at) last_playback_info_at
    FROM jellyfin_servers js
    LEFT JOIN stremio_managed_accounts sma ON sma.server_id=js.id
    GROUP BY js.id
    ORDER BY js.stremio_enabled DESC,js.stremio_priority,js.priority,js.name`);
  return result.rows;
}

async function get(serverId){
  const result=await query(`SELECT id,name,slug,server_class,base_url,public_url,enabled,health_status,
      stremio_enabled,stremio_priority,(api_key_encrypted IS NOT NULL) api_configured
    FROM jellyfin_servers WHERE id=$1`,[serverId]);
  return result.rows[0]||null;
}

async function validateForManagedStremio(serverId){
  const server=await get(serverId);
  if(!server)throw new Error('Jellyfin server not found.');
  if(!server.enabled)throw new Error('Enable the Jellyfin server before enabling it for Stremio.');
  if(!server.public_url)throw new Error('A public Jellyfin URL is required for direct Stremio playback.');
  if(!server.api_configured)throw new Error('A Jellyfin API key is required before enabling this managed Stremio source.');
  // Uses the existing write-only server API credential. It never leaves CAPTAiNFiN.
  await registry.request(serverId,'/System/Info/Public',{timeoutMs:8000});
  return server;
}

async function configure({serverId,enabled,sourcePriority,actorUserId=null}){
  const target=Boolean(enabled),nextPriority=priority(sourcePriority||100);
  const server=target?await validateForManagedStremio(serverId):await get(serverId);
  if(!server)throw new Error('Jellyfin server not found.');
  await transaction(async db=>{
    await db.query(`UPDATE jellyfin_servers
      SET stremio_enabled=$2,stremio_priority=$3,updated_at=NOW()
      WHERE id=$1`,[serverId,target,nextPriority]);
    await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_source.configure','jellyfin_server',$2,$3::jsonb)`,[
      actorUserId,serverId,JSON.stringify({enabled:target,priority:nextPriority})
    ]);
  });
  return get(serverId);
}

async function enabled(){
  const result=await query(`SELECT id,name,slug,server_class,base_url,public_url,priority,stremio_priority
    FROM jellyfin_servers
    WHERE enabled=TRUE AND stremio_enabled=TRUE AND public_url IS NOT NULL AND api_key_encrypted IS NOT NULL
    ORDER BY stremio_priority,priority,name`);
  return result.rows;
}

async function accountsForEntitlement(entitlementId){
  const result=await query(`SELECT sma.*,js.name server_name,js.public_url,js.stremio_priority,
      ja.jellyfin_user_id,ja.jellyfin_username,ja.disabled account_disabled
    FROM stremio_managed_accounts sma
    JOIN jellyfin_servers js ON js.id=sma.server_id
    JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
    WHERE sma.entitlement_id=$1 AND sma.status='active' AND js.enabled=TRUE AND js.stremio_enabled=TRUE
      AND ja.disabled=FALSE
    ORDER BY js.stremio_priority,js.priority,js.name`,[entitlementId]);
  return result.rows;
}

module.exports={priority,list,get,validateForManagedStremio,configure,enabled,accountsForEntitlement};
