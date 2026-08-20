'use strict';

const {query,transaction}=require('../db');
const registry=require('../jellyfin/registry');

const SUPPORTED_TYPES=new Set(['movies','tvshows','mixed']);

function cleanType(value){return String(value||'mixed').trim().toLowerCase();}
function normalizedLibrary(folder){
  const libraryId=String(folder?.ItemId||folder?.itemId||'').trim();
  const collectionType=cleanType(folder?.CollectionType||folder?.collectionType);
  if(!libraryId||!SUPPORTED_TYPES.has(collectionType))return null;
  return{libraryId,name:String(folder?.Name||folder?.name||'Unnamed library').trim()||'Unnamed library',collectionType};
}
async function discover(serverId){
  const raw=await registry.request(serverId,'/Library/VirtualFolders',{timeoutMs:8000});
  return(Array.isArray(raw)?raw:[]).map(normalizedLibrary).filter(Boolean);
}
async function stored(serverId){
  const result=await query(`SELECT library_id,name,collection_type,selected,available,updated_at
    FROM stremio_managed_source_libraries WHERE server_id=$1 ORDER BY available DESC,name`,[serverId]);
  return result.rows;
}
function mergeDiscovered(saved,discovered){
  const byId=new Map(saved.map(row=>[String(row.library_id),row])),hasSaved=saved.length>0,seen=new Set(),rows=[];
  for(const library of discovered){
    const prior=byId.get(String(library.libraryId));seen.add(String(library.libraryId));
    rows.push({library_id:library.libraryId,name:library.name,collection_type:library.collectionType,selected:prior?prior.selected:!hasSaved,available:true});
  }
  for(const row of saved){if(!seen.has(String(row.library_id)))rows.push({...row,available:false});}
  return rows.sort((a,b)=>Number(b.available)-Number(a.available)||String(a.name).localeCompare(String(b.name)));
}
async function forPage(serverId){
  const saved=await stored(serverId);
  try{return{libraries:mergeDiscovered(saved,await discover(serverId)),error:null};}
  catch(error){return{libraries:saved,error:String(error?.message||error).slice(0,700)};}
}
async function refresh(serverId,actorUserId=null){
  const [saved,discovered]=await Promise.all([stored(serverId),discover(serverId)]),hasSaved=saved.length>0,prior=new Map(saved.map(row=>[String(row.library_id),row]));
  await transaction(async db=>{
    await db.query(`UPDATE stremio_managed_source_libraries SET available=FALSE,updated_at=NOW() WHERE server_id=$1`,[serverId]);
    for(const library of discovered){
      const previous=prior.get(String(library.libraryId));
      await db.query(`INSERT INTO stremio_managed_source_libraries(server_id,library_id,name,collection_type,selected,available)
        VALUES($1,$2,$3,$4,$5,TRUE)
        ON CONFLICT(server_id,library_id) DO UPDATE SET name=EXCLUDED.name,collection_type=EXCLUDED.collection_type,available=TRUE,updated_at=NOW()`,
        [serverId,library.libraryId,library.name,library.collectionType,previous?Boolean(previous.selected):!hasSaved]);
    }
    await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_libraries.refresh','jellyfin_server',$2,$3::jsonb)`,[actorUserId,serverId,JSON.stringify({libraries:discovered.length})]);
  });
  return stored(serverId);
}
async function save(serverId,libraryIds,actorUserId=null){
  const requested=new Set((Array.isArray(libraryIds)?libraryIds:[libraryIds]).map(value=>String(value||'')).filter(Boolean)),discovered=await discover(serverId),allowed=new Set(discovered.map(library=>String(library.libraryId)));
  for(const id of requested)if(!allowed.has(id))throw new Error('One or more selected Jellyfin libraries are no longer available.');
  await transaction(async db=>{
    await db.query(`UPDATE stremio_managed_source_libraries SET selected=FALSE,available=FALSE,updated_at=NOW() WHERE server_id=$1`,[serverId]);
    for(const library of discovered){
      await db.query(`INSERT INTO stremio_managed_source_libraries(server_id,library_id,name,collection_type,selected,available)
        VALUES($1,$2,$3,$4,$5,TRUE)
        ON CONFLICT(server_id,library_id) DO UPDATE SET name=EXCLUDED.name,collection_type=EXCLUDED.collection_type,selected=EXCLUDED.selected,available=TRUE,updated_at=NOW()`,
        [serverId,library.libraryId,library.name,library.collectionType,requested.has(String(library.libraryId))]);
    }
    await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.managed_libraries.update','jellyfin_server',$2,$3::jsonb)`,[actorUserId,serverId,JSON.stringify({libraryIds:[...requested]})]);
  });
  return[...requested];
}
async function indexFilter(serverId){
  const result=await query(`SELECT library_id FROM stremio_managed_source_libraries
    WHERE server_id=$1 AND selected=TRUE AND available=TRUE ORDER BY name`,[serverId]);
  const exists=await query(`SELECT EXISTS(SELECT 1 FROM stremio_managed_source_libraries WHERE server_id=$1) configured`,[serverId]);
  return{configured:exists.rows[0]?.configured===true,libraryIds:result.rows.map(row=>String(row.library_id))};
}
async function counts(serverId){
  const result=await query(`SELECT COUNT(*) FILTER(WHERE available)::int available,COUNT(*) FILTER(WHERE available AND selected)::int selected
    FROM stremio_managed_source_libraries WHERE server_id=$1`,[serverId]);
  return result.rows[0]||{available:0,selected:0};
}

module.exports={SUPPORTED_TYPES,normalizedLibrary,discover,stored,mergeDiscovered,forPage,refresh,save,indexFilter,counts};
