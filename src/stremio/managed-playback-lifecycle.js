'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const outbound=require('../security/outbound-url-policy');
const registry=require('../jellyfin/registry');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');
const entitlements=require('./entitlements');
const managedEntitlements=require('./managed-entitlements');
const sourceAdmission=require('./source-admission');

// Direct Stremio playback never returns through CAPTAiNFiN, so Jellyfin session
// activity is the authoritative liveness signal. Keep the background window
// short enough that a stopped direct stream cannot hold a concurrency slot for
// several minutes, while retaining a startup grace for newly registered plays.
const SESSION_ACTIVE_SECONDS=60;
const ADMISSION_ACTIVE_SECONDS=30;
const START_GRACE_SECONDS=45;
const PLAYBACK_TOKEN_PREFIX='stremio-jf-playback-token';
let timer=null;
let running=false;

function deviceId(rawLease){return `cf-stremio-${crypto.createHash('sha256').update(String(rawLease||''),'utf8').digest('hex').slice(0,24)}`;}
function safeHeaderValue(value){return String(value||'').replace(/["\\\r\n]/g,'').slice(0,180);}
function loginAuthorization(id){return `MediaBrowser Client="CAPTAiNFiN Stremio", Device="Stremio", DeviceId="${safeHeaderValue(id)}", Version="1.0"`;}
function authorization(token,id){return `MediaBrowser Client="CAPTAiNFiN Stremio", Device="Stremio", DeviceId="${safeHeaderValue(id)}", Version="1.0", Token="${safeHeaderValue(token)}"`;}
function serverUrl(mapping,endpoint){const base=new URL(String(mapping.base_url)),url=new URL(endpoint,`${base.toString().replace(/\/$/,'')}/`);if(url.origin!==base.origin)throw new Error('Managed playback lifecycle endpoint escaped the configured Jellyfin origin.');return url;}
async function authenticatePlayback(mapping,id){
  const password=managedEntitlements.decryptPlaybackPassword(mapping);if(!password)throw new Error('Managed Stremio playback password is unavailable.');
  const response=await outbound.safeFetch(serverUrl(mapping,'/Users/AuthenticateByName'),{purpose:`Managed Stremio playback login on ${mapping.server_name||mapping.server_id}`,method:'POST',timeoutMs:10000,headers:{Authorization:loginAuthorization(id),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify({Username:String(mapping.jellyfin_username||''),Pw:password})});
  const text=await response.text();let body={};try{body=text?JSON.parse(text):{};}catch{}
  if(!response.ok||!body.AccessToken||!body.User?.Id){const error=new Error(`Managed Stremio Jellyfin authentication failed (${response.status}).`);error.status=response.status;throw error;}
  if(String(body.User.Id)!==String(mapping.jellyfin_user_id))throw new Error('Managed playback authentication returned the wrong Jellyfin user.');
  return String(body.AccessToken);
}
async function restrictedPost(mapping,token,endpoint,body,id){
  const response=await outbound.safeFetch(serverUrl(mapping,endpoint),{purpose:`Managed Stremio playback lifecycle on ${mapping.server_name||mapping.server_id}`,method:'POST',timeoutMs:8000,headers:{Authorization:authorization(token,id),Accept:'application/json','Content-Type':'application/json'},body:JSON.stringify(body)});
  if(!response.ok){const error=new Error(`Managed Jellyfin playback lifecycle returned HTTP ${response.status}`);error.status=response.status;throw error;}return true;
}
function normalizePlayMethod(value){const method=String(value||'DirectPlay');return['DirectPlay','DirectStream','Transcode'].includes(method)?method:'DirectPlay';}
function playbackBody({itemId,mediaSourceId,playSessionId,positionTicks=0,playMethod='DirectPlay'}){return{ItemId:String(itemId),MediaSourceId:String(mediaSourceId||''),PlaySessionId:String(playSessionId||''),PositionTicks:Number.isFinite(Number(positionTicks))?Math.max(0,Math.floor(Number(positionTicks))):0,IsPaused:false,IsMuted:false,CanSeek:true,PlayMethod:normalizePlayMethod(playMethod)};}
async function resolveSession(mapping,id,itemId,{activeWithinSeconds=60}={}){
  const sessions=await registry.request(mapping.server_id,`/Sessions?activeWithinSeconds=${encodeURIComponent(Math.max(30,Math.min(600,Number(activeWithinSeconds)||60)))}`,{timeoutMs:8000});
  if(!Array.isArray(sessions))return null;const userId=String(mapping.jellyfin_user_id||'').toLowerCase(),item=String(itemId||'').toLowerCase();
  return sessions.find(session=>String(session?.UserId||'').toLowerCase()===userId&&String(session?.DeviceId||'')===String(id)&&(!item||String(session?.NowPlayingItem?.Id||'').toLowerCase()===item))||null;
}
async function existingPlayback(mapping,rawLease){
  const leaseHash=sourceAdmission.hash(rawLease),result=await query(`SELECT device_id,jellyfin_session_id,playback_token_encrypted FROM stremio_source_playback_leases WHERE lease_hash=$1 AND entitlement_id=$2 AND managed_mapping_id=$3 AND expires_at>NOW()`,[leaseHash,mapping.entitlement_id,mapping.id]),row=result.rows[0];
  if(!row?.playback_token_encrypted||!row.device_id)return null;
  try{return{deviceId:String(row.device_id),jellyfinSessionId:row.jellyfin_session_id?String(row.jellyfin_session_id):null,accessToken:decryptWithEnv(row.playback_token_encrypted,entitlements.TOKEN_ENV,PLAYBACK_TOKEN_PREFIX),reused:true};}catch{return null;}
}
async function start(mapping,rawLease,{itemId,mediaSourceId,playSessionId,playMethod='DirectPlay'}){
  const prior=await existingPlayback(mapping,rawLease);if(prior)return prior;
  const id=deviceId(rawLease),token=await authenticatePlayback(mapping,id),method=normalizePlayMethod(playMethod),body=playbackBody({itemId,mediaSourceId,playSessionId,positionTicks:0,playMethod:method});
  try{
    await restrictedPost(mapping,token,'/Sessions/Playing',body,id);
    let session=null;try{session=await resolveSession(mapping,id,itemId,{activeWithinSeconds:SESSION_ACTIVE_SECONDS});}catch(error){console.warn(`Unable to resolve newly started managed Stremio Jellyfin session: ${error.message}`);}
    const leaseHash=sourceAdmission.hash(rawLease),encryptedToken=encryptWithEnv(token,entitlements.TOKEN_ENV,PLAYBACK_TOKEN_PREFIX);
    await query(`UPDATE stremio_source_playback_leases SET device_id=$2,jellyfin_session_id=$3,playback_token_encrypted=$4,play_method=$5,lifecycle_started_at=COALESCE(lifecycle_started_at,NOW()),lifecycle_last_seen_at=NOW(),last_seen_at=NOW() WHERE lease_hash=$1`,[leaseHash,id,session?.Id?String(session.Id):null,encryptedToken,method]);
    return{deviceId:id,jellyfinSessionId:session?.Id?String(session.Id):null,accessToken:token,reused:false};
  }catch(error){await logoutToken(mapping,token,id).catch(()=>{});throw error;}
}
async function logoutToken(mapping,token,id){
  if(!token)return false;try{const response=await outbound.safeFetch(serverUrl(mapping,'/Sessions/Logout'),{purpose:`Managed Stremio playback logout on ${mapping.server_name||mapping.server_id}`,method:'POST',timeoutMs:8000,headers:{Authorization:authorization(token,id),Accept:'application/json'}});return response.ok;}catch{return false;}
}
async function activeManagedLeases(limit=2000,entitlementId=null){
  const result=await query(`SELECT l.*,sma.status mapping_status,js.name server_name,js.base_url,js.enabled server_enabled,js.stremio_enabled,ja.jellyfin_user_id,ja.disabled account_disabled
    FROM stremio_source_playback_leases l
    LEFT JOIN stremio_managed_accounts sma ON sma.id=l.managed_mapping_id
    LEFT JOIN jellyfin_servers js ON js.id=sma.server_id
    LEFT JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
    WHERE l.managed_mapping_id IS NOT NULL AND ($2::uuid IS NULL OR l.entitlement_id=$2)
    ORDER BY l.first_seen_at
    LIMIT $1`,[Math.max(1,Math.min(10000,Number(limit)||2000)),entitlementId||null]);
  return result.rows;
}
async function snapshotServers(rows){
  const valid=rows.filter(row=>row.server_id&&row.server_enabled&&row.stremio_enabled&&row.mapping_status==='active'&&!row.account_disabled),servers=[...new Map(valid.map(row=>[String(row.server_id),{id:row.server_id,name:row.server_name}])).values()],byServer=new Map(),failures=[];
  const settled=await Promise.allSettled(servers.map(server=>registry.request(server.id,'/Sessions?activeWithinSeconds=600',{timeoutMs:8000})));
  for(let i=0;i<settled.length;i+=1){const server=servers[i],result=settled[i];if(result.status==='fulfilled'){byServer.set(String(server.id),Array.isArray(result.value)?result.value:[]);}else failures.push({serverId:server.id,error:String(result.reason?.message||result.reason)});}
  return{byServer,failures};
}
function matchingSession(row,sessions){
  const id=String(row.jellyfin_session_id||''),device=String(row.device_id||''),user=String(row.jellyfin_user_id||'').toLowerCase(),item=String(row.item_id||'').toLowerCase();
  return sessions.find(session=>id&&String(session?.Id||'')===id)||sessions.find(session=>String(session?.UserId||'').toLowerCase()===user&&device&&String(session?.DeviceId||'')===device&&(!item||String(session?.NowPlayingItem?.Id||'').toLowerCase()===item))||null;
}
function sessionFresh(session,now=Date.now(),activeSeconds=SESSION_ACTIVE_SECONDS){if(!session?.NowPlayingItem)return false;const last=Date.parse(session.LastActivityDate||''),window=Math.max(10,Math.min(600,Number(activeSeconds)||SESSION_ACTIVE_SECONDS));return Number.isFinite(last)&&now-last<=window*1000;}
async function stopLease(row,reason='stale'){
  let token=null;if(row.playback_token_encrypted){try{token=decryptWithEnv(row.playback_token_encrypted,entitlements.TOKEN_ENV,PLAYBACK_TOKEN_PREFIX);}catch(error){console.warn(`Unable to decrypt managed Stremio playback token: ${error.message}`);}}
  if(token&&row.base_url&&row.device_id){try{await restrictedPost(row,token,'/Sessions/Playing/Stopped',playbackBody({itemId:row.item_id,mediaSourceId:row.media_source_id,playSessionId:row.play_session_id,positionTicks:row.position_ticks||0,playMethod:row.play_method||'DirectPlay'}),row.device_id);}catch(error){console.warn(`Unable to report managed Stremio playback stop: ${error.message}`);}}
  if(row.jellyfin_session_id&&row.server_id){try{await registry.request(row.server_id,`/Sessions/${encodeURIComponent(String(row.jellyfin_session_id))}/Playing/Stop`,{method:'POST',timeoutMs:8000});}catch(error){console.warn(`Unable to issue fallback stop for managed Stremio Jellyfin session ${row.jellyfin_session_id}: ${error.message}`);}}
  if(token&&row.base_url)await logoutToken(row,token,row.device_id).catch(()=>{});
  await sourceAdmission.releaseHash(row.lease_hash);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES(NULL,'stremio.managed_playback.ended','stremio_entitlement',$1,$2::jsonb)`,[row.entitlement_id,JSON.stringify({serverId:row.server_id||null,jellyfinSessionId:row.jellyfin_session_id||null,reason})]).catch(()=>{});
}
async function reconcile({entitlementId=null,activeSeconds=SESSION_ACTIVE_SECONDS}={}){
  const rows=await activeManagedLeases(2000,entitlementId);if(!rows.length)return{leases:0,active:0,ended:0,serverFailures:0};
  const snapshot=await snapshotServers(rows),now=Date.now();let active=0,ended=0;
  for(const row of rows){
    if(row.mapping_status!=='active'||!row.server_enabled||!row.stremio_enabled||row.account_disabled){await stopLease(row,'mapping_inactive');ended+=1;continue;}
    const sessions=snapshot.byServer.get(String(row.server_id))||[],session=matchingSession(row,sessions),started=Date.parse(row.lifecycle_started_at||row.first_seen_at||'')||0;
    if(sessionFresh(session,now,activeSeconds)){
      active+=1;const position=Number(session?.PlayState?.PositionTicks||0)||0;
      await sourceAdmission.touchHash(row.lease_hash,{seconds:SESSION_ACTIVE_SECONDS});
      await query(`UPDATE stremio_source_playback_leases SET jellyfin_session_id=COALESCE($2,jellyfin_session_id),position_ticks=$3 WHERE lease_hash=$1`,[row.lease_hash,session?.Id?String(session.Id):null,position||null]);continue;
    }
    if(started&&now-started<START_GRACE_SECONDS*1000)continue;
    await stopLease(row,session?'jellyfin_session_stale':'jellyfin_session_missing');ended+=1;
  }
  return{leases:rows.length,active,ended,serverFailures:snapshot.failures.length};
}
async function reconcileEntitlement(entitlementId,{activeSeconds=ADMISSION_ACTIVE_SECONDS}={}){
  if(!entitlementId)return{leases:0,active:0,ended:0,serverFailures:0};
  return reconcile({entitlementId,activeSeconds});
}
function startManager({intervalMs=15000}={}){
  if(timer)return timer;const delay=Math.max(5000,Math.min(60000,Number(intervalMs)||15000));timer=setInterval(async()=>{if(running)return;running=true;try{await reconcile();}catch(error){console.warn(`Managed Stremio playback lifecycle cycle failed: ${error.message}`);}finally{running=false;}},delay);timer.unref?.();return timer;
}

module.exports={SESSION_ACTIVE_SECONDS,ADMISSION_ACTIVE_SECONDS,START_GRACE_SECONDS,PLAYBACK_TOKEN_PREFIX,deviceId,safeHeaderValue,loginAuthorization,authorization,serverUrl,authenticatePlayback,restrictedPost,normalizePlayMethod,playbackBody,resolveSession,existingPlayback,start,logoutToken,activeManagedLeases,snapshotServers,matchingSession,sessionFresh,stopLease,reconcile,reconcileEntitlement,startManager};
