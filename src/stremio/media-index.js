'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const registry=require('../jellyfin/registry');
const managedLibraries=require('./managed-library-selection');
const indexLock=require('./index-lock');

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
        await client.query(`INSERT INTO stremio_media_index(server_id,imdb_id,item_id,item_type,name,production_year,path,scan_generation,updated_at,seen_at)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,NOW(),NOW())
          ON CONFLICT(server_id,item_id) DO UPDATE SET imdb_id=EXCLUDED.imdb_id,item_type=EXCLUDED.item_type,name=EXCLUDED.name,
            production_year=EXCLUDED.production_year,path=EXCLUDED.path,scan_generation=EXCLUDED.scan_generation,updated_at=NOW(),seen_at=NOW()`,
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

async function indexServer(serverId,{pageSize=500}={}){
  const generation=crypto.randomUUID(),startedAt=new Date();
  await query(`INSERT INTO stremio_media_index_state(server_id,status,last_started_at,last_error,updated_at)
    VALUES($1,'running',NOW(),NULL,NOW())
    ON CONFLICT(server_id) DO UPDATE SET status='running',last_started_at=NOW(),last_error=NULL,updated_at=NOW()`,[serverId]);
  let total=0;
  try{
    const targets=await scanTargets(serverId);
    for(const parentId of targets)total+=await scanTarget(serverId,parentId,generation,pageSize);
    await transaction(async client=>{
      // An explicitly configured source with zero selected libraries has zero
      // targets; this generation sweep therefore clears its local Stremio index.
      await client.query(`DELETE FROM stremio_media_index WHERE server_id=$1 AND scan_generation<>$2`,[serverId,generation]);
      const count=await client.query(`SELECT COUNT(*)::int n FROM stremio_media_index WHERE server_id=$1`,[serverId]);
      await client.query(`UPDATE stremio_media_index_state SET status='ready',last_completed_at=NOW(),item_count=$2,last_error=NULL,updated_at=NOW() WHERE server_id=$1`,[serverId,Number(count.rows[0]?.n||0)]);
    });
    return{serverId,processed:total,startedAt,ok:true};
  }catch(error){
    await query(`UPDATE stremio_media_index_state SET status='failed',last_error=$2,updated_at=NOW() WHERE server_id=$1`,[serverId,String(error.message||error).slice(0,2000)]).catch(()=>{});
    throw error;
  }
}

async function indexAll(){
  const servers=await eligibleServers();let processed=0,failed=0;
  for(const server of servers){try{const r=await indexServer(server.id);processed+=Number(r.processed||0);}catch(error){failed++;console.error(`Stremio media index failed for ${server.name}:`,error.message);}}
  return{total:servers.length,processed,failed};
}

async function saveLibrariesAndReset(serverId,libraryIds,actorUserId=null){
  // Jellyfin discovery/validation happens before taking the worker lock so a slow
  // server cannot hold the database transaction open. Once validated, selection
  // persistence and local-index reset are one locked transaction: both happen or neither does.
  const prepared=await managedLibraries.prepareSave(serverId,libraryIds);
  return indexLock.withIndexTransaction(async client=>{
    const selected=await managedLibraries.writePrepared(client,serverId,prepared,actorUserId);
    const deleted=await client.query(`DELETE FROM stremio_media_index WHERE server_id=$1`,[serverId]);
    await client.query(`INSERT INTO stremio_media_index_state(server_id,status,item_count,last_error,updated_at)
      VALUES($1,'never',0,NULL,NOW()) ON CONFLICT(server_id) DO UPDATE
      SET status='never',item_count=0,last_error=NULL,updated_at=NOW()`,[serverId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_index.clear','jellyfin_server',$2,$3::jsonb)`,[actorUserId,serverId,JSON.stringify({deleted:deleted.rowCount,reason:'library_selection_update'})]);
    return{selected,deleted:deleted.rowCount};
  },{busyMessage:'Stremio indexing is currently running. Wait for the current run to finish before changing managed library selections.'});
}
async function clearAndReset(serverId,actorUserId=null){
  return indexLock.withIndexTransaction(async client=>{
    const deleted=await client.query(`DELETE FROM stremio_media_index WHERE server_id=$1`,[serverId]);
    await client.query(`INSERT INTO stremio_media_index_state(server_id,status,item_count,last_error,updated_at)
      VALUES($1,'never',0,NULL,NOW()) ON CONFLICT(server_id) DO UPDATE
      SET status='never',item_count=0,last_error=NULL,updated_at=NOW()`,[serverId]);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_index.clear','jellyfin_server',$2,$3::jsonb)`,[actorUserId,serverId,JSON.stringify({deleted:deleted.rowCount})]);
    return{deleted:deleted.rowCount};
  },{busyMessage:'Stremio indexing is currently running. Wait for the current run to finish before rebuilding this managed source.'});
}
async function clearAll(actorUserId=null){
  return indexLock.withIndexTransaction(async client=>{
    const deleted=await client.query(`DELETE FROM stremio_media_index`);
    await client.query(`UPDATE stremio_media_index_state SET status='never',item_count=0,last_error=NULL,updated_at=NOW()`);
    await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_index.clear_all','stremio_runtime',NULL,$2::jsonb)`,[actorUserId,JSON.stringify({deleted:deleted.rowCount})]);
    return{deleted:deleted.rowCount};
  },{busyMessage:'Stremio indexing is currently running. Wait for the current run to finish before clearing managed indexes.'});
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

async function states(){
  const r=await query(`SELECT s.id,s.name,s.stremio_enabled,s.enabled,s.health_status,
    COALESCE(i.status,'never') index_status,COALESCE(i.item_count,0)::int item_count,i.last_started_at,i.last_completed_at,i.last_error
    FROM jellyfin_servers s LEFT JOIN stremio_media_index_state i ON i.server_id=s.id
    ORDER BY s.enabled DESC,s.priority,s.name`);
  return r.rows;
}

module.exports={normalizeImdb,valueItems,eligibleServers,scanTargets,scanTarget,indexServer,indexAll,saveLibrariesAndReset,clearAndReset,clearAll,lookupAll,lookup,states};
