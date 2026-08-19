'use strict';

const {query}=require('../db');
const registry=require('../jellyfin/registry');

let timer=null;
let running=false;

async function activeEntitlements(){
  const result=await query(`SELECT e.id,e.customer_id,e.stream_limit
    FROM stremio_entitlements e
    WHERE e.status='active' AND EXISTS(
      SELECT 1 FROM stremio_managed_accounts sma
      WHERE sma.entitlement_id=e.id AND sma.status='active'
    )`);
  return result.rows;
}
async function mappings(entitlementId){
  const result=await query(`SELECT sma.id,sma.server_id,sma.jellyfin_account_id,ja.jellyfin_user_id,js.name server_name
    FROM stremio_managed_accounts sma
    JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
    JOIN jellyfin_servers js ON js.id=sma.server_id
    WHERE sma.entitlement_id=$1 AND sma.status='active' AND js.enabled=TRUE AND js.stremio_enabled=TRUE AND ja.disabled=FALSE`,[entitlementId]);
  return result.rows;
}
async function sessionsFor(mapping){
  const payload=await registry.request(mapping.server_id,'/Sessions?activeWithinSeconds=180',{timeoutMs:8000});
  if(!Array.isArray(payload))return[];
  const userId=String(mapping.jellyfin_user_id||'').toLowerCase();
  return payload.filter(session=>session?.Id&&session?.NowPlayingItem&&String(session.UserId||'').toLowerCase()===userId).map(session=>({
    mapping,session,
    startedAt:Date.parse(session.NowPlayingItem?.DateCreated||session.LastActivityDate||'')||Date.parse(session.LastActivityDate||'')||Date.now()
  }));
}
async function stop(entry,entitlement){
  const sessionId=String(entry.session.Id);
  await registry.request(entry.mapping.server_id,`/Sessions/${encodeURIComponent(sessionId)}/Playing/Stop`,{method:'POST',timeoutMs:8000});
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES(NULL,'stremio.managed_stream.limit_stop','stremio_entitlement',$1,$2::jsonb)`,[
    entitlement.id,JSON.stringify({serverId:entry.mapping.server_id,jellyfinSessionId:sessionId,streamLimit:Number(entitlement.stream_limit||1)})
  ]).catch(()=>{});
}
async function reconcileOne(entitlement){
  const limit=Math.max(1,Math.min(50,Number(entitlement.stream_limit||1))),accounts=await mappings(entitlement.id);
  if(!accounts.length)return{active:0,limit,stopped:0};
  const settled=await Promise.allSettled(accounts.map(sessionsFor)),active=[];
  for(const result of settled)if(result.status==='fulfilled')active.push(...result.value);
  if(active.length<=limit)return{active:active.length,limit,stopped:0};
  // Keep the oldest already-playing sessions and stop the newest excess sessions.
  // Re-read each target server immediately before stopping so a naturally-ended
  // playback is not acted on using a stale snapshot.
  active.sort((a,b)=>a.startedAt-b.startedAt);let stopped=0;
  for(const entry of active.slice(limit)){
    try{
      const fresh=await sessionsFor(entry.mapping);
      if(!fresh.some(row=>String(row.session.Id)===String(entry.session.Id)))continue;
      await stop(entry,entitlement);stopped+=1;
    }catch(error){console.warn(`Unable to stop excess managed Stremio session on ${entry.mapping.server_name}:`,error.message);}
  }
  return{active:active.length,limit,stopped};
}
async function reconcileAll(){
  const entitlements=await activeEntitlements();let checked=0,stopped=0,failed=0;
  for(const entitlement of entitlements){try{const result=await reconcileOne(entitlement);checked+=1;stopped+=result.stopped;}catch(error){failed+=1;console.warn(`Managed Stremio concurrency reconciliation failed for ${entitlement.id}:`,error.message);}}
  return{total:entitlements.length,checked,stopped,failed};
}
function start({intervalMs=15000}={}){
  if(timer)return timer;const delay=Math.max(10000,Math.min(60000,Number(intervalMs)||15000));
  timer=setInterval(async()=>{if(running)return;running=true;try{await reconcileAll();}catch(error){console.warn('Managed Stremio concurrency cycle failed:',error.message);}finally{running=false;}},delay);timer.unref?.();return timer;
}

module.exports={activeEntitlements,mappings,sessionsFor,reconcileOne,reconcileAll,start};
