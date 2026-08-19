'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const outbound=require('../security/outbound-url-policy');
const registry=require('../jellyfin/registry');
const entitlements=require('./entitlements');
const sourceAdmission=require('./source-admission');

const SESSION_ACTIVE_SECONDS=180;
const START_GRACE_SECONDS=45;
let timer=null;
let running=false;

function deviceId(rawLease){return `cf-stremio-${crypto.createHash('sha256').update(String(rawLease||''),'utf8').digest('hex').slice(0,24)}`;}
function safeHeaderValue(value){return String(value||'').replace(/["\\\r\n]/g,'').slice(0,180);}
function authorization(token,id){return `MediaBrowser Client="CAPTAiNFiN Stremio", Device="Stremio", DeviceId="${safeHeaderValue(id)}", Version="1.0", Token="${safeHeaderValue(token)}"`;}
function runtimeMapping(row){return{...row,server_id:row.server_id,base_url:row.base_url,server_name:row.server_name,jellyfin_access_token_encrypted:row.access_token_encrypted};}
async function restrictedPost(mapping,endpoint,body,id){
  if(typeof endpoint!=='string'||!endpoint.startsWith('/')||endpoint.startsWith('//'))throw new Error('Invalid managed playback lifecycle endpoint.');
  const base=new URL(String(mapping.base_url)),url=new URL(endpoint,`${base.toString().replace(/\/$/,'')}/`);if(url.origin!==base.origin)throw new Error('Managed playback lifecycle endpoint escaped the configured Jellyfin origin.');
  const token=entitlements.accessToken(runtimeMapping(mapping));if(!token)throw new Error('Managed Stremio playback token is unavailable.');
  const response=await outbound.safeFetch(url,{purpose:`Managed Stremio playback lifecycle on ${mapping.server_name||mapping.server_id}`,method:'POST',timeoutMs:8000,headers:{Authorization:authorization(token,id),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){const error=new Error(`Managed Jellyfin playback lifecycle returned HTTP ${response.status}`);error.status=response.status;throw error;}
  return true;
}
function playbackBody({itemId,mediaSourceId,playSessionId,positionTicks=0}){
  return{ItemId:String(itemId),MediaSourceId:String(mediaSourceId||''),PlaySessionId:String(playSessionId||''),PositionTicks:Number.isFinite(Number(positionTicks))?Math.max(0,Math.floor(Number(positionTicks))):0,IsPaused:false,IsMuted:false,CanSeek:true,PlayMethod:'DirectPlay'};
}
async function resolveSession(mapping,id,itemId,{activeWithinSeconds=60}={}){
  const sessions=await registry.request(mapping.server_id,`/Sessions?activeWithinSeconds=${encodeURIComponent(Math.max(30,Math.min(600,Number(activeWithinSeconds)||60)))}`,{timeoutMs:8000});
  if(!Array.isArray(sessions))return null;const userId=String(mapping.jellyfin_user_id||'').toLowerCase(),item=String(itemId||'').toLowerCase();
  return sessions.find(session=>String(session?.UserId||'').toLowerCase()===userId&&String(session?.DeviceId||'')===String(id)&&(!item||String(session?.NowPlayingItem?.Id||'').toLowerCase()===item))||null;
}
async function start(mapping,rawLease,{itemId,mediaSourceId,playSessionId}){
  const id=deviceId(rawLease),body=playbackBody({itemId,mediaSourceId,playSessionId,positionTicks:0});
  await restrictedPost(mapping,'/Sessions/Playing',body,id);
  let session=null;try{session=await resolveSession(mapping,id,itemId,{activeWithinSeconds:60});}catch(error){console.warn(`Unable to resolve newly started managed Stremio Jellyfin session: ${error.message}`);}
  const leaseHash=sourceAdmission.hash(rawLease);
  await query(`UPDATE stremio_source_playback_leases SET device_id=$2,jellyfin_session_id=$3,lifecycle_started_at=COALESCE(lifecycle_started_at,NOW()),lifecycle_last_seen_at=NOW(),last_seen_at=NOW() WHERE lease_hash=$1`,[leaseHash,id,session?.Id?String(session.Id):null]);
  return{deviceId:id,jellyfinSessionId:session?.Id?String(session.Id):null};
}
async function activeManagedLeases(limit=2000){
  const result=await query(`SELECT l.*,sma.access_token_encrypted,js.name server_name,js.base_url,ja.jellyfin_user_id
    FROM stremio_source_playback_leases l
    JOIN stremio_managed_accounts sma ON sma.id=l.managed_mapping_id AND sma.status='active'
    JOIN jellyfin_servers js ON js.id=sma.server_id AND js.enabled=TRUE AND js.stremio_enabled=TRUE
    JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id AND ja.disabled=FALSE
    WHERE l.managed_mapping_id IS NOT NULL
    ORDER BY l.first_seen_at
    LIMIT $1`,[Math.max(1,Math.min(10000,Number(limit)||2000))]);
  return result.rows;
}
async function snapshotServers(rows){
  const servers=[...new Map(rows.map(row=>[String(row.server_id),{id:row.server_id,name:row.server_name}])).values()],byServer=new Map(),failures=[];
  const settled=await Promise.allSettled(servers.map(server=>registry.request(server.id,'/Sessions?activeWithinSeconds=600',{timeoutMs:8000})));
  for(let i=0;i<settled.length;i+=1){const server=servers[i],result=settled[i];if(result.status==='fulfilled'){byServer.set(String(server.id),Array.isArray(result.value)?result.value:[]);}else failures.push({serverId:server.id,error:String(result.reason?.message||result.reason)});}
  return{byServer,failures};
}
function matchingSession(row,sessions){
  const id=String(row.jellyfin_session_id||''),device=String(row.device_id||''),user=String(row.jellyfin_user_id||'').toLowerCase(),item=String(row.item_id||'').toLowerCase();
  return sessions.find(session=>id&&String(session?.Id||'')===id)||sessions.find(session=>String(session?.UserId||'').toLowerCase()===user&&device&&String(session?.DeviceId||'')===device&&(!item||String(session?.NowPlayingItem?.Id||'').toLowerCase()===item))||null;
}
function sessionFresh(session,now=Date.now()){
  if(!session?.NowPlayingItem)return false;const last=Date.parse(session.LastActivityDate||'');return Number.isFinite(last)&&now-last<=SESSION_ACTIVE_SECONDS*1000;
}
async function stopLease(row,reason='stale'){
  if(row.jellyfin_session_id){try{await registry.request(row.server_id,`/Sessions/${encodeURIComponent(String(row.jellyfin_session_id))}/Playing/Stop`,{method:'POST',timeoutMs:8000});}catch(error){console.warn(`Unable to stop managed Stremio Jellyfin session ${row.jellyfin_session_id}: ${error.message}`);}}
  await sourceAdmission.releaseHash(row.lease_hash);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES(NULL,'stremio.managed_playback.ended','stremio_entitlement',$1,$2::jsonb)`,[row.entitlement_id,JSON.stringify({serverId:row.server_id,jellyfinSessionId:row.jellyfin_session_id||null,reason})]).catch(()=>{});
}
async function reconcile(){
  const rows=await activeManagedLeases();if(!rows.length)return{leases:0,active:0,ended:0,serverFailures:0};
  const snapshot=await snapshotServers(rows),now=Date.now();let active=0,ended=0;
  for(const row of rows){const sessions=snapshot.byServer.get(String(row.server_id))||[],session=matchingSession(row,sessions),started=Date.parse(row.lifecycle_started_at||row.first_seen_at||'')||0;
    if(sessionFresh(session,now)){
      active+=1;await sourceAdmission.touchHash(row.lease_hash);
      const position=Number(session?.PlayState?.PositionTicks||0)||0;await query(`UPDATE stremio_source_playback_leases SET jellyfin_session_id=COALESCE($2,jellyfin_session_id),lifecycle_last_seen_at=NOW() WHERE lease_hash=$1`,[row.lease_hash,session?.Id?String(session.Id):null]);
      if(position>0)await query(`UPDATE stremio_source_playback_leases SET position_ticks=$2 WHERE lease_hash=$1`,[row.lease_hash,position]).catch(()=>{});
      continue;
    }
    if(started&&now-started<START_GRACE_SECONDS*1000)continue;
    await stopLease(row,session?'jellyfin_session_stale':'jellyfin_session_missing');ended+=1;
  }
  return{leases:rows.length,active,ended,serverFailures:snapshot.failures.length};
}
function startManager({intervalMs=15000}={}){
  if(timer)return timer;const delay=Math.max(5000,Math.min(60000,Number(intervalMs)||15000));timer=setInterval(async()=>{if(running)return;running=true;try{await reconcile();}catch(error){console.warn(`Managed Stremio playback lifecycle cycle failed: ${error.message}`);}finally{running=false;}},delay);timer.unref?.();return timer;
}

module.exports={SESSION_ACTIVE_SECONDS,START_GRACE_SECONDS,deviceId,authorization,playbackBody,resolveSession,start,activeManagedLeases,snapshotServers,matchingSession,sessionFresh,stopLease,reconcile,startManager};
