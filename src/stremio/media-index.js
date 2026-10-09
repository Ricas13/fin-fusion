'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const registry=require('../jellyfin/registry');
const managedLibraries=require('./managed-library-selection');
const indexLock=require('./index-lock');
const operationLock=require('./operation-lock');

const MANAGED_REFRESH_HOURS=3;
const MANAGED_BATCH_LIMIT=1;

function normalizeImdb(value){const id=String(value||'').trim().toLowerCase();return /^tt\d{5,12}$/.test(id)?id:null;}
function valueItems(payload){return Array.isArray(payload?.Items)?payload.Items:Array.isArray(payload?.items)?payload.items:[];}

async function eligibleServers(){
  const r=await query(`SELECT id,name FROM jellyfin_servers WHERE enabled=TRUE AND stremio_enabled=TRUE ORDER BY priority,name`);
  return r.rows;
}
async function scanTargets(serverId){
  const filter=await managedLibraries.indexFilter(serverId);
  // Existing installations had no managed-library selection table. Until an
  // operator saves/refreshes a selection, preserve the historic all-library
  // behaviour so an upgrade cannot silently empty a working managed index.
  if(!filter.configured)return[null];
  return filter.libraryIds;
}
async function scanTarget(serverId,parentId,generation,pageSize){
  let startIndex=0,processed=0;
  while(true){
    const qs=new URLSearchParams({Recursive:'true',IncludeItemTypes:'Movie,Series',Fields:'ProviderIds,Path',HasImdbId:'true',StartIndex:String(startIndex),Limit:String(pageSize)});
    if(parentId)qs.set('ParentId',String(parentId));
    const payload=await registry.request(serverId,`/Items?${qs.toString()}`,{timeoutMs:30000}),items=valueItems(payload);
    if(!items.length)break;
    await transaction(async client=>{
      for(const item of items){
        const imdb=normalizeImdb(item.ProviderIds?.Imdb||item.ProviderIds?.IMDB||item.providerIds?.Imdb),type=String(item.Type||item.type||'');
        if(!imdb||!['Movie','Series'].includes(type)||!item.Id)continue;
        await client.query(`INSERT INTO stremio_media_index_build(generation,server_id,imdb_id,item_id,item_type,name,production_year,path,updated_at,seen_at)
          VALUES($8,$1,$2,$3,$4,$5,$6,$7,NOW(),NOW())
          ON CONFLICT(generation,server_id,item_id) DO UPDATE SET imdb_id=EXCLUDED.imdb_id,item_type=EXCLUDED.item_type,name=EXCLUDED.name,
            production_year=EXCLUDED.production_year,path=EXCLUDED.path,updated_at=NOW(),seen_at=NOW()`,
          [serverId,imdb,String(item.Id),type,item.Name||null,Number.isInteger(item.ProductionYear)?item.ProductionYear:null,item.Path||null,generation]);
        processed++;
      }
    });
    startIndex+=items.length;
    const declared=Number(payload?.TotalRecordCount??payload?.totalRecordCount??0);
    if(items.length<pageSize||(declared&&startIndex>=declared))break;
  }
  return processed;
}

async function indexServerUnlocked(serverId,{pageSize=500}={}){
  const generation=crypto.randomUUID(),startedAt=new Date();
  await transaction(async client=>{
    // A crashed/abandoned shadow build is never serving traffic, so it is safe
    // to discard before starting the next generation for this server.
    await client.query(`DELETE FROM stremio_media_index_build WHERE server_id=$1`,[serverId]);
    await client.query(`INSERT INTO stremio_media_index_state(server_id,status,last_started_at,last_error,updated_at)
      VALUES($1,'running',NOW(),NULL,NOW())
      ON CONFLICT(server_id) DO UPDATE SET status='running',last_started_at=NOW(),last_error=NULL,updated_at=NOW()`,[serverId]);
  });
  let total=0;
  try{
    const targets=await scanTargets(serverId);
    for(const parentId of targets)total+=await scanTarget(serverId,parentId,generation,pageSize);
    await transaction(async client=>{
      const staged=await client.query(`SELECT COUNT(*)::int n FROM stremio_media_index_build WHERE server_id=$1 AND generation=$2`,[serverId,generation]);
      const itemCount=Number(staged.rows[0]?.n||0);
      const state=await client.query('SELECT status FROM stremio_media_index_state WHERE server_id=$1 FOR UPDATE',[serverId]);
      const rerunRequested=state.rows[0]?.status==='queued';

      // PostgreSQL readers keep seeing the previous committed snapshot until
      // this transaction commits. The delete+insert therefore acts as one
      // atomic catalogue flip rather than exposing an empty/partial index.
      await client.query(`DELETE FROM stremio_media_index WHERE server_id=$1`,[serverId]);
      await client.query(`INSERT INTO stremio_media_index(server_id,imdb_id,item_id,item_type,name,production_year,path,scan_generation,updated_at,seen_at)
        SELECT server_id,imdb_id,item_id,item_type,name,production_year,path,generation,updated_at,seen_at
        FROM stremio_media_index_build WHERE server_id=$1 AND generation=$2`,[serverId,generation]);
      await client.query(`DELETE FROM stremio_media_index_build WHERE server_id=$1 AND generation=$2`,[serverId,generation]);
      await client.query(`UPDATE stremio_media_index_state SET status=$2,last_completed_at=NOW(),item_count=$3,last_error=NULL,updated_at=NOW() WHERE server_id=$1`,[serverId,rerunRequested?'queued':'ready',itemCount]);
    });
    return{serverId,processed:total,startedAt,ok:true};
  }catch(error){
    await transaction(async client=>{
      await client.query(`DELETE FROM stremio_media_index_build WHERE server_id=$1 AND generation=$2`,[serverId,generation]);
      // Keep last_completed_at and item_count untouched: they describe the
      // previous complete serving snapshot, which remains valid after failure.
      await client.query(`UPDATE stremio_media_index_state SET status=CASE WHEN status='queued' THEN 'queued' ELSE 'failed' END,last_error=$2,updated_at=NOW() WHERE server_id=$1`,[serverId,String(error.message||error).slice(0,2000)]);
    }).catch(()=>{});
    throw error;
  }
}
async function indexServer(serverId,options={}){return operationLock.withLock(`managed-index:${serverId}`,()=>indexServerUnlocked(serverId,options));}
function managedBatchLimit(value=MANAGED_BATCH_LIMIT){return Math.max(1,Math.min(4,Number(value)||MANAGED_BATCH_LIMIT));}
async function dueServers({limit=MANAGED_BATCH_LIMIT}={}){
  const safeLimit=managedBatchLimit(limit);
  const result=await query(`SELECT js.id,js.name
    FROM jellyfin_servers js
    LEFT JOIN stremio_media_index_state i ON i.server_id=js.id
    WHERE js.enabled=TRUE AND js.stremio_enabled=TRUE
      AND (
        i.server_id IS NULL
        OR i.status IN ('never','queued')
        OR i.last_completed_at IS NULL
        OR i.last_completed_at<=NOW()-($2||' hours')::interval
        OR (i.status='failed' AND COALESCE(i.last_started_at,'1970-01-01'::timestamptz)<=NOW()-INTERVAL '15 minutes')
      )
    ORDER BY CASE WHEN i.status='queued' THEN 0 WHEN i.last_completed_at IS NULL THEN 1 ELSE 2 END,
             COALESCE(i.last_completed_at,'1970-01-01'::timestamptz),js.priority,js.name
    LIMIT $1`,[safeLimit,String(MANAGED_REFRESH_HOURS)]);
  return result.rows;
}
async function dueServerCount(){
  const result=await query(`SELECT COUNT(*)::int n
    FROM jellyfin_servers js
    LEFT JOIN stremio_media_index_state i ON i.server_id=js.id
    WHERE js.enabled=TRUE AND js.stremio_enabled=TRUE
      AND (
        i.server_id IS NULL
        OR i.status IN ('never','queued')
        OR i.last_completed_at IS NULL
        OR i.last_completed_at<=NOW()-($1||' hours')::interval
        OR (i.status='failed' AND COALESCE(i.last_started_at,'1970-01-01'::timestamptz)<=NOW()-INTERVAL '15 minutes')
      )`,[String(MANAGED_REFRESH_HOURS)]);
  return Number(result.rows[0]?.n||0);
}
async function indexDueServers({limit=MANAGED_BATCH_LIMIT}={}){
  const rows=await dueServers({limit});let processed=0,failed=0;
  for(const server of rows){try{const r=await indexServer(server.id);processed+=Number(r.processed||0);}catch(error){failed++;console.error(`Stremio media index failed for ${server.name}:`,error.message);}}
  const remainingDue=await dueServerCount();
  return{total:rows.length,processed,failed,remainingDue,waiting:remainingDue};
}

async function servingCount(client,serverId){
  const count=await client.query(`SELECT COUNT(*)::int n FROM stremio_media_index WHERE server_id=$1`,[serverId]);
  return Number(count.rows[0]?.n||0);
}
async function queueManagedRefresh(client,serverId,itemCount){
  await client.query(`INSERT INTO stremio_media_index_state(server_id,status,item_count,last_error,updated_at)
    VALUES($1,'queued',$2,NULL,NOW()) ON CONFLICT(server_id) DO UPDATE
    SET status='queued',item_count=EXCLUDED.item_count,last_error=NULL,updated_at=NOW()`,[serverId,itemCount]);
}

async function saveLibrariesAndReset(serverId,libraryIds,actorUserId=null){
  // Keep the currently committed catalogue serving while a replacement is
  // built from the new library selection. Serialize against the same server's
  // active scan so a late scan cannot overwrite a freshly-saved selection.
  return operationLock.withLock(`managed-index:${serverId}`,async()=>{
    const prepared=await managedLibraries.prepareSave(serverId,libraryIds);
    return indexLock.withIndexTransaction(async client=>{
    const selected=await managedLibraries.writePrepared(client,serverId,prepared,actorUserId);
    const preserved=await servingCount(client,serverId);
    await queueManagedRefresh(client,serverId,preserved);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_index.refresh','jellyfin_server',$2,$3::jsonb)`,[actorUserId,serverId,JSON.stringify({preserved,reason:'library_selection_update',zeroDowntime:true})]);
    return{selected,preserved,deleted:0,queued:true};
  },{busyMessage:'Stremio indexing is currently running. Wait for the current run to finish before changing managed library selections.'});
  });
}
async function clearAndReset(serverId,actorUserId=null){
  return operationLock.withLock(`managed-index:${serverId}`,()=>indexLock.withIndexTransaction(async client=>{
    const preserved=await servingCount(client,serverId);
    await queueManagedRefresh(client,serverId,preserved);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_index.refresh','jellyfin_server',$2,$3::jsonb)`,[actorUserId,serverId,JSON.stringify({preserved,reason:'manual_rebuild',zeroDowntime:true})]);
    return{preserved,deleted:0,queued:true};
  },{busyMessage:'Stremio indexing is currently running. Wait for the current run to finish before rebuilding this managed source.'}));
}
async function lookupAll(serverId,imdbId,itemType){
  const imdb=normalizeImdb(imdbId);if(!imdb)return[];
  const type=itemType==='series'?'Series':'Movie';
  const r=await query(`SELECT * FROM stremio_media_index WHERE server_id=$1 AND imdb_id=$2 AND item_type=$3 ORDER BY updated_at DESC,item_id`,[serverId,imdb,type]);
  return r.rows;
}
async function lookup(serverId,imdbId,itemType){
  return (await lookupAll(serverId,imdbId,itemType))[0]||null;
}
async function removeItem(serverId,itemId){
  if(!serverId||!itemId)return 0;
  const result=await query('DELETE FROM stremio_media_index WHERE server_id=$1 AND item_id=$2',[serverId,String(itemId)]);
  if(result.rowCount)await query(`UPDATE stremio_media_index_state SET item_count=GREATEST(0,item_count-$2),updated_at=NOW() WHERE server_id=$1`,[serverId,Number(result.rowCount)]).catch(()=>{});
  return Number(result.rowCount||0);
}

async function states(){
  const r=await query(`SELECT s.id,s.name,s.stremio_enabled,s.enabled,s.health_status,
    COALESCE(i.status,'never') index_status,COALESCE(i.item_count,0)::int item_count,i.last_started_at,i.last_completed_at,i.last_error
    FROM jellyfin_servers s LEFT JOIN stremio_media_index_state i ON i.server_id=s.id
    ORDER BY s.enabled DESC,s.priority,s.name`);
  return r.rows;
}

module.exports={MANAGED_REFRESH_HOURS,MANAGED_BATCH_LIMIT,normalizeImdb,valueItems,eligibleServers,scanTargets,scanTarget,indexServerUnlocked,indexServer,managedBatchLimit,dueServers,dueServerCount,indexDueServers,saveLibrariesAndReset,clearAndReset,lookupAll,lookup,removeItem,states};
