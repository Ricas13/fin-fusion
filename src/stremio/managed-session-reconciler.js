'use strict';

const {query}=require('../db');
const registry=require('../jellyfin/registry');
const managedEntitlements=require('./managed-entitlements');

let timer=null;
let running=false;

function sessionKey(serverId,userId){return `${String(serverId)}:${String(userId||'').toLowerCase()}`;}
async function activeMappings(){
  const result=await query(`SELECT e.id entitlement_id,e.customer_id,e.stream_limit,
      sma.id mapping_id,sma.server_id,ja.jellyfin_user_id,js.name server_name
    FROM stremio_entitlements e
    JOIN stremio_managed_accounts sma ON sma.entitlement_id=e.id
    JOIN jellyfin_accounts ja ON ja.id=sma.jellyfin_account_id
    JOIN jellyfin_servers js ON js.id=sma.server_id
    WHERE e.status='active' AND sma.status='active' AND js.enabled=TRUE AND js.stremio_enabled=TRUE AND ja.disabled=FALSE
    ORDER BY e.id,js.stremio_priority,js.priority,js.name`);
  return result.rows;
}
async function activeEntitlements(){
  const rows=await activeMappings(),seen=new Map();
  for(const row of rows)if(!seen.has(String(row.entitlement_id)))seen.set(String(row.entitlement_id),{id:row.entitlement_id,customer_id:row.customer_id,stream_limit:row.stream_limit});
  return [...seen.values()];
}
async function mappings(entitlementId){return(await activeMappings()).filter(row=>String(row.entitlement_id)===String(entitlementId));}
async function fetchServerSessions(server){
  const payload=await registry.request(server.server_id,'/Sessions?activeWithinSeconds=180',{timeoutMs:8000});
  return Array.isArray(payload)?payload:[];
}
async function snapshotServers(rows){
  const servers=[...new Map(rows.map(row=>[String(row.server_id),{server_id:row.server_id,server_name:row.server_name}])).values()];
  const settled=await Promise.allSettled(servers.map(fetchServerSessions)),byUser=new Map(),failures=[];
  for(let i=0;i<settled.length;i+=1){
    const result=settled[i],server=servers[i];
    if(result.status!=='fulfilled'){failures.push({serverId:server.server_id,error:String(result.reason?.message||result.reason)});continue;}
    for(const session of result.value){
      if(!session?.Id||!session?.NowPlayingItem||!session?.UserId)continue;
      const key=sessionKey(server.server_id,session.UserId),list=byUser.get(key)||[];
      list.push({server,session,startedAt:Date.parse(session.NowPlayingItem?.DateCreated||session.LastActivityDate||'')||Date.parse(session.LastActivityDate||'')||Date.now()});
      byUser.set(key,list);
    }
  }
  return{byUser,serversQueried:servers.length,failures};
}
function sessionsFor(mapping,snapshot){
  return(snapshot?.byUser?.get(sessionKey(mapping.server_id,mapping.jellyfin_user_id))||[]).map(entry=>({mapping,session:entry.session,startedAt:entry.startedAt}));
}
async function stop(entry,entitlement){
  const sessionId=String(entry.session.Id);
  await registry.request(entry.mapping.server_id,`/Sessions/${encodeURIComponent(sessionId)}/Playing/Stop`,{method:'POST',timeoutMs:8000});
  await query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES(NULL,'stremio.managed_stream.limit_stop','stremio_entitlement',$1,$2::jsonb)`,[entitlement.id,JSON.stringify({serverId:entry.mapping.server_id,jellyfinSessionId:sessionId,streamLimit:Number(entitlement.stream_limit||1)})]).catch(()=>{});
}
async function reconcileOne(entitlement,accounts,snapshot){
  const limit=Math.max(1,Math.min(50,Number(entitlement.stream_limit||1))),active=accounts.flatMap(account=>sessionsFor(account,snapshot));
  if(active.length<=limit)return{active:active.length,limit,stopped:0};
  active.sort((a,b)=>a.startedAt-b.startedAt);let stopped=0;
  for(const entry of active.slice(limit)){
    try{await stop(entry,entitlement);stopped+=1;}
    catch(error){console.warn(`Unable to stop excess managed Stremio session on ${entry.mapping.server_name}:`,error.message);}
  }
  return{active:active.length,limit,stopped};
}
async function reconcileAll(){
  const revoked=await managedEntitlements.revokeInactiveMappings(),rows=await activeMappings();
  if(!rows.length)return{total:0,checked:0,stopped:0,failed:0,revoked,serversQueried:0,serverFailures:0};
  const snapshot=await snapshotServers(rows),groups=new Map();
  for(const row of rows){const key=String(row.entitlement_id),group=groups.get(key)||{entitlement:{id:row.entitlement_id,customer_id:row.customer_id,stream_limit:row.stream_limit},accounts:[]};group.accounts.push(row);groups.set(key,group);}
  let checked=0,stopped=0,failed=0;
  for(const {entitlement,accounts} of groups.values()){
    try{const result=await reconcileOne(entitlement,accounts,snapshot);checked+=1;stopped+=result.stopped;}
    catch(error){failed+=1;console.warn(`Managed Stremio concurrency reconciliation failed for ${entitlement.id}:`,error.message);}
  }
  return{total:groups.size,checked,stopped,failed,revoked,serversQueried:snapshot.serversQueried,serverFailures:snapshot.failures.length};
}
function start({intervalMs=5000}={}){
  if(timer)return timer;const delay=Math.max(5000,Math.min(60000,Number(intervalMs)||5000));
  timer=setInterval(async()=>{if(running)return;running=true;try{await reconcileAll();}catch(error){console.warn('Managed Stremio concurrency cycle failed:',error.message);}finally{running=false;}},delay);timer.unref?.();return timer;
}

module.exports={sessionKey,activeMappings,activeEntitlements,mappings,fetchServerSessions,snapshotServers,sessionsFor,reconcileOne,reconcileAll,start};
