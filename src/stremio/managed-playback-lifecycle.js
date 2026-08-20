'use strict';

const crypto=require('crypto');
const {query}=require('../db');
const outbound=require('../security/outbound-url-policy');
const registry=require('../jellyfin/registry');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');
const entitlements=require('./entitlements');
const managedEntitlements=require('./managed-entitlements');

const SESSION_ACTIVE_SECONDS=20;
const TRACKING_SECONDS=20;
const START_GRACE_SECONDS=10;
const PLAYBACK_TOKEN_PREFIX='stremio-jf-playback-token';
let timer=null;
let running=false;

function issuePlaybackKey(){return crypto.randomBytes(24).toString('base64url');}
function hashPlaybackKey(rawKey){const value=String(rawKey||'').trim();if(value.length<24||value.length>200)throw new Error('Invalid Stremio playback key.');return crypto.createHash('sha256').update(value,'utf8').digest('hex');}
function deviceId(rawKey){return `cf-stremio-${crypto.createHash('sha256').update(String(rawKey||''),'utf8').digest('hex').slice(0,24)}`;}
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
async function resolveSession(mapping,id,itemId,{activeWithinSeconds=SESSION_ACTIVE_SECONDS}={}){
  const sessions=await registry.request(mapping.server_id,`/Sessions?activeWithinSeconds=${encodeURIComponent(Math.max(5,Math.min(600,Number(activeWithinSeconds)||SESSION_ACTIVE_SECONDS)))}`,{timeoutMs:8000});
  if(!Array.isArray(sessions))return null;const userId=String(mapping.jellyfin_user_id||'').toLowerCase(),item=String(itemId||'').toLowerCase();
  return sessions.find(session=>String(session?.UserId||'').toLowerCase()===userId&&String(session?.DeviceId||'')===String(id)&&(!item||String(session?.NowPlayingItem?.Id||'').toLowerCase()===item))||null;
}
async function existingPlayback(mapping,rawKey){
  const playbackHash=hashPlaybackKey(rawKey),result=await query(`SELECT device_id,jellyfin_session_id,playback_token_encrypted FROM stremio_source_playback_leases WHERE lease_hash=$1 AND entitlement_id=$2 AND managed_mapping_id=$3 AND expires_at>NOW()`,[playbackHash,mapping.entitlement_id,mapping.id]),row=result.rows[0];
  if(!row?.playback_token_encrypted||!row.device_id)return null;
  try{return{deviceId:String(row.device_id),jellyfinSessionId:row.jellyfin_session_id?String(row.jellyfin_session_id):null,accessToken:decryptWithEnv(row.playback_token_encrypted,entitlements.TOKEN_ENV,PLAYBACK_TOKEN_PREFIX),reused:true};}catch{return null;}
}
async function registerPlayback(mapping,rawKey,{itemId,mediaSourceId,playSessionId,playMethod,deviceId:resolvedDeviceId,jellyfinSessionId,encryptedToken}){
  const playbackHash=hashPlaybackKey(rawKey);
  await query(`INSERT INTO stremio_source_playback_leases(
      lease_hash,entitlement_id,customer_id,source_id,item_id,first_seen_at,last_seen_at,expires_at,
      managed_mapping_id,server_id,jellyfin_user_id,device_id,play_session_id,media_source_id,play_method,
      lifecycle_started_at,lifecycle_last_seen_at,jellyfin_session_id,playback_token_encrypted)
    VALUES($1,$2,$3,NULL,$4,NOW(),NOW(),NOW()+($5||' seconds')::interval,$6,$7,$8,$9,$10,$11,$12,NOW(),NOW(),$13,$14)
    ON CONFLICT(lease_hash) DO UPDATE SET
      entitlement_id=EXCLUDED.entitlement_id,customer_id=EXCLUDED.customer_id,item_id=EXCLUDED.item_id,
      last_seen_at=NOW(),expires_at=EXCLUDED.expires_at,managed_mapping_id=EXCLUDED.managed_mapping_id,
      server_id=EXCLUDED.server_id,jellyfin_user_id=EXCLUDED.jellyfin_user_id,device_id=EXCLUDED.device_id,
      play_session_id=EXCLUDED.play_session_id,media_source_id=EXCLUDED.media_source_id,play_method=EXCLUDED.play_method,
      lifecycle_started_at=COALESCE(stremio_source_playback_leases.lifecycle_started_at,NOW()),lifecycle_last_seen_at=NOW(),
      jellyfin_session_id=COALESCE(EXCLUDED.jellyfin_session_id,stremio_source_playback_leases.jellyfin_session_id),
      playback_token_encrypted=EXCLUDED.playback_token_encrypted`,
    [playbackHash,mapping.entitlement_id,mapping.customer_id,String(itemId),String(TRACKING_SECONDS),mapping.id,mapping.server_id,mapping.jellyfin_user_id,resolvedDeviceId,String(playSessionId||''),String(mediaSourceId||''),normalizePlayMethod(playMethod),jellyfinSessionId||null,encryptedToken]);
  return playbackHash;
}
async function start(mapping,rawKey,{itemId,mediaSourceId,playSessionId,playMethod='DirectPlay'}){
  const prior=await existingPlayback(mapping,rawKey);if(prior)return prior;
  const id=deviceId(rawKey),token=await authenticatePlayback(mapping,id),method=normalizePlayMethod(playMethod),body=playbackBody({itemId,mediaSourceId,playSessionId,positionTicks:0,playMethod:method});
  try{
    await restrictedPost(mapping,token,'/Sessions/Playing',body,id);
    let session=null;try{session=await resolveSession(mapping,id,itemId,{activeWithinSeconds:SESSION_ACTIVE_SECONDS});}catch(error){console.warn(`Unable to resolve newly started managed Stremio Jellyfin session: ${error.message}`);}
    const encryptedToken=encryptWithEnv(token,entitlements.TOKEN_ENV,PLAYBACK_TOKEN_PREFIX);
    await registerPlayback(mapping,rawKey,{itemId,mediaSourceId,playSessionId,playMethod:method,deviceId:id,jellyfinSessionId:session?.Id?String(session.Id):null,encryptedToken});
    return{deviceId:id,jellyfinSessionId:session?.Id?String(session.Id):null,accessToken:token,reused:false};
  }catch(error){await logoutToken(mapping,token,id).catch(()=>{});throw error;}
}
async function logoutToken(mapping,token,id){
  if(!token)return false;try{const response=await outbound.safeFetch(serverUrl(mapping,'/Sessions/Logout'),{purpose:`Managed Stremio playback logout on ${mapping.server_name||mapping.server_id}`,method:'POST',timeoutMs:8000,headers:{Authorization:authorization(token,id),Accept:'application/json'}});return response.ok;}catch{return false;}
}
async function activeManagedPlaybacks(limit=2000,entitlementId=null){
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
  const activeWindow=Math.max(30,SESSION_ACTIVE_SECONDS),settled=await Promise.allSettled(servers.map(server=>registry.request(server.id,`/Sessions?activeWithinSeconds=${encodeURIComponent(activeWindow)}`,{timeoutMs:8000})));
  for(let i=0;i<settled.length;i+=1){const server=servers[i],result=settled[i];if(result.status==='fulfilled'){byServer.set(String(server.id),Array.isArray(result.value)?result.value:[]);}else failures.push({serverId:server.id,error:String(result.reason?.message||result.reason)});}
  return{byServer,failures,failedServerIds:new Set(failures.map(row=>String(row.serverId)))};
}
function matchingSession(row,sessions){
  const id=String(row.jellyfin_session_id||''),device=String(row.device_id||''),user=String(row.jellyfin_user_id||'').toLowerCase(),item=String(row.item_id||'').toLowerCase();
  return sessions.find(session=>id&&String(session?.Id||'')===id)||sessions.find(session=>String(session?.UserId||'').toLowerCase()===user&&device&&String(session?.DeviceId||'')===device&&(!item||String(session?.NowPlayingItem?.Id||'').toLowerCase()===item))||null;
}
function sessionFresh(session,now=Date.now(),activeSeconds=SESSION_ACTIVE_SECONDS){if(!session?.NowPlayingItem)return false;const last=Date.parse(session.LastActivityDate||''),window=Math.max(2,Math.min(600,Number(activeSeconds)||SESSION_ACTIVE_SECONDS));return Number.isFinite(last)&&now-last<=window*1000;}
async function extendTracking(playbackHash,{seconds=TRACKING_SECONDS}={}){const value=String(playbackHash||'');if(!/^[a-f0-9]{64}$/.test(value))return false;const r=await query(`UPDATE stremio_source_playback_leases SET last_seen_at=NOW(),lifecycle_last_seen_at=NOW(),expires_at=NOW()+($2||' seconds')::interval WHERE lease_hash=$1`,[value,String(Math.max(5,Math.min(600,Number(seconds)||TRACKING_SECONDS)))]);return r.rowCount>0;}
async function removeTracking(playbackHash){const value=String(playbackHash||'');if(!/^[a-f0-9]{64}$/.test(value))return false;const r=await query(`DELETE FROM stremio_source_playback_leases WHERE lease_hash=$1`,[value]);return r.rowCount>0;}
async function stopPlayback(row,reason='stale'){
  let token=null;if(row.playback_token_encrypted){try{token=decryptWithEnv(row.playback_token_encrypted,entitlements.TOKEN_ENV,PLAYBACK_TOKEN_PREFIX);}catch(error){console.warn(`Unable to decrypt managed Stremio playback token: ${error.message}`);}}
  if(token&&row.base_url&&row.device_id){try{await restrictedPost(row,token,'/Sessions/Playing/Stopped',playbackBody({itemId:row.item_id,mediaSourceId:row.media_source_id,playSessionId:row.play_session_id,positionTicks:row.position_ticks||0,playMethod:row.play_method||'DirectPlay'}),row.device_id);}catch(error){console.warn(`Unable to report managed Stremio playback stop: ${error.message}`);}}
  if(row.jellyfin_session_id&&row.server_id){try{await registry.request(row.server_id,`/Sessions/${encodeURIComponent(String(row.jellyfin_session_id))}/Playing/Stop`,{method:'POST',timeoutMs:8000});}catch(error){console.warn(`Unable to issue fallback stop for managed Stremio Jellyfin session ${row.jellyfin_session_id}: ${error.message}`);}}
  if(token&&row.base_url)await logoutToken(row,token,row.device_id).catch(()=>{});
  await removeTracking(row.lease_hash);
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES(NULL,'stremio.managed_playback.ended','stremio_entitlement',$1,$2::jsonb)`,[row.entitlement_id,JSON.stringify({serverId:row.server_id||null,jellyfinSessionId:row.jellyfin_session_id||null,reason})]).catch(()=>{});
}
async function reconcile({entitlementId=null,activeSeconds=SESSION_ACTIVE_SECONDS}={}){
  const rows=await activeManagedPlaybacks(2000,entitlementId);if(!rows.length)return{playbacks:0,active:0,ended:0,serverFailures:0};
  const snapshot=await snapshotServers(rows),now=Date.now();let active=0,ended=0;
  for(const row of rows){
    if(row.mapping_status!=='active'||!row.server_enabled||!row.stremio_enabled||row.account_disabled){await stopPlayback(row,'mapping_inactive');ended+=1;continue;}
    if(snapshot.failedServerIds.has(String(row.server_id))){await extendTracking(row.lease_hash,{seconds:TRACKING_SECONDS});active+=1;continue;}
    const sessions=snapshot.byServer.get(String(row.server_id))||[],session=matchingSession(row,sessions),started=Date.parse(row.lifecycle_started_at||row.first_seen_at||'')||0;
    if(sessionFresh(session,now,activeSeconds)){
      active+=1;const position=Number(session?.PlayState?.PositionTicks||0)||0;
      await extendTracking(row.lease_hash,{seconds:TRACKING_SECONDS});
      await query(`UPDATE stremio_source_playback_leases SET jellyfin_session_id=COALESCE($2,jellyfin_session_id),position_ticks=$3 WHERE lease_hash=$1`,[row.lease_hash,session?.Id?String(session.Id):null,position||null]);continue;
    }
    if(!session&&started&&now-started<START_GRACE_SECONDS*1000)continue;
    await stopPlayback(row,session?'jellyfin_session_stale':'jellyfin_session_missing');ended+=1;
  }
  return{playbacks:rows.length,active,ended,serverFailures:snapshot.failures.length};
}
function startManager({intervalMs=5000}={}){
  if(timer)return timer;const delay=Math.max(5000,Math.min(60000,Number(intervalMs)||5000));timer=setInterval(async()=>{if(running)return;running=true;try{await reconcile();}catch(error){console.warn(`Managed Stremio playback lifecycle cycle failed: ${error.message}`);}finally{running=false;}},delay);timer.unref?.();return timer;
}

module.exports={SESSION_ACTIVE_SECONDS,TRACKING_SECONDS,START_GRACE_SECONDS,PLAYBACK_TOKEN_PREFIX,issuePlaybackKey,hashPlaybackKey,deviceId,safeHeaderValue,loginAuthorization,authorization,serverUrl,authenticatePlayback,restrictedPost,normalizePlayMethod,playbackBody,resolveSession,existingPlayback,registerPlayback,start,logoutToken,activeManagedPlaybacks,snapshotServers,matchingSession,sessionFresh,extendTracking,removeTracking,stopPlayback,reconcile,startManager};
