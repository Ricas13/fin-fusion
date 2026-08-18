'use strict';

const crypto=require('crypto');
const {query,transaction}=require('../db');
const client=require('./source-client');

const PAGE_SIZE=250;
const PAGE_DELAY_MS=100;
const INCREMENTAL_HOURS=6;
const FULL_RECONCILE_DAYS=7;

function sleep(ms){return new Promise(resolve=>setTimeout(resolve,ms));}
function normalizeImdb(value){const id=String(value||'').trim().toLowerCase();return /^tt\d{5,12}$/.test(id)?id:null;}
function dateValue(value){if(!value)return null;const d=new Date(value);return Number.isNaN(d.getTime())?null:d;}
async function source(sourceId){const r=await query('SELECT * FROM stremio_sources WHERE id=$1',[sourceId]);return r.rows[0]||null;}
async function selectedLibraries(sourceId){const r=await query(`SELECT library_id,name,collection_type FROM stremio_source_libraries WHERE source_id=$1 AND selected=TRUE AND available=TRUE ORDER BY name`,[sourceId]);return r.rows;}
async function state(sourceId){const r=await query('SELECT * FROM stremio_source_index_state WHERE source_id=$1',[sourceId]);return r.rows[0]||null;}
function fullDue(row,forceFull=false){if(forceFull||row?.force_full||!row?.last_full_completed_at)return true;return Date.now()-new Date(row.last_full_completed_at).getTime()>=FULL_RECONCILE_DAYS*86400000;}
async function queue(sourceId,{full=false}={}){await query(`INSERT INTO stremio_source_index_state(source_id,status,next_incremental_at,force_full,updated_at) VALUES($1,'queued',NOW(),$2,NOW()) ON CONFLICT(source_id) DO UPDATE SET status='queued',next_incremental_at=NOW(),force_full=stremio_source_index_state.force_full OR EXCLUDED.force_full,updated_at=NOW()`,[sourceId,Boolean(full)]);}
async function refreshProgress(sourceId){
  const count=await query('SELECT COUNT(*)::int n FROM stremio_source_media_index WHERE source_id=$1',[sourceId]);
  const itemCount=Number(count.rows[0]?.n||0);
  await query(`UPDATE stremio_source_index_state SET status='running',item_count=$2,updated_at=NOW() WHERE source_id=$1`,[sourceId,itemCount]);
  return itemCount;
}
async function indexSource(sourceId,{forceFull=false}={}){
  const src=await source(sourceId);if(!src)throw new Error('Stremio source not found.');if(!src.enabled)return{sourceId,processed:0,skipped:'disabled'};
  const libraries=await selectedLibraries(sourceId);if(!libraries.length)throw new Error('Select at least one Jellyfin library before indexing this source.');
  const prior=await state(sourceId),mode=fullDue(prior,forceFull)?'full':'incremental',generation=crypto.randomUUID(),startedAt=new Date();
  const overlapSince=prior?.last_completed_at?new Date(new Date(prior.last_completed_at).getTime()-5*60*1000):null;
  await query(`INSERT INTO stremio_source_index_state(source_id,status,last_mode,last_started_at,last_error,updated_at) VALUES($1,'running',$2,NOW(),NULL,NOW()) ON CONFLICT(source_id) DO UPDATE SET status='running',last_mode=EXCLUDED.last_mode,last_started_at=NOW(),last_error=NULL,updated_at=NOW()`,[sourceId,mode]);
  console.log(`Stremio source index started: ${src.name||sourceId} mode=${mode} libraries=${libraries.length}`);
  let changed=0;
  try{
    for(const library of libraries){
      let startIndex=0;
      while(true){
        const qs=new URLSearchParams({UserId:String(src.jellyfin_user_id),ParentId:String(library.library_id),Recursive:'true',IncludeItemTypes:'Movie,Series',Fields:'ProviderIds,Path,DateLastSaved',EnableImages:'false',StartIndex:String(startIndex),Limit:String(PAGE_SIZE)});
        if(mode==='incremental'&&overlapSince)qs.set('MinDateLastSaved',overlapSince.toISOString());
        const payload=await client.request(src,`/Items?${qs.toString()}`,{timeoutMs:20000,maxBytes:12*1024*1024}),items=Array.isArray(payload.Items)?payload.Items:[];
        if(!items.length)break;
        await transaction(async db=>{
          for(const item of items){
            const imdb=normalizeImdb(item.ProviderIds?.Imdb||item.ProviderIds?.IMDB||item.providerIds?.Imdb),type=String(item.Type||item.type||'');
            if(!imdb||!['Movie','Series'].includes(type)||!item.Id)continue;
            await db.query(`INSERT INTO stremio_source_media_index(source_id,library_id,imdb_id,item_id,item_type,name,production_year,path,date_last_saved,scan_generation,updated_at,seen_at)
              VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NOW(),NOW())
              ON CONFLICT(source_id,item_id) DO UPDATE SET library_id=EXCLUDED.library_id,imdb_id=EXCLUDED.imdb_id,item_type=EXCLUDED.item_type,name=EXCLUDED.name,production_year=EXCLUDED.production_year,path=EXCLUDED.path,date_last_saved=EXCLUDED.date_last_saved,scan_generation=EXCLUDED.scan_generation,updated_at=NOW(),seen_at=NOW()`,
              [sourceId,library.library_id,imdb,String(item.Id),type,item.Name||null,Number.isInteger(item.ProductionYear)?item.ProductionYear:null,item.Path||null,dateValue(item.DateLastSaved),generation]);
            changed++;
          }
        });
        await refreshProgress(sourceId);
        startIndex+=items.length;
        const declared=Number(payload.TotalRecordCount||0);
        if(items.length<PAGE_SIZE||(declared&&startIndex>=declared))break;
        await sleep(PAGE_DELAY_MS);
      }
    }
    if(mode==='full')await query(`DELETE FROM stremio_source_media_index i WHERE i.source_id=$1 AND (i.scan_generation<>$2 OR NOT EXISTS(SELECT 1 FROM stremio_source_libraries l WHERE l.source_id=i.source_id AND l.library_id=i.library_id AND l.selected=TRUE AND l.available=TRUE))`,[sourceId,generation]);
    const count=await query('SELECT COUNT(*)::int n FROM stremio_source_media_index WHERE source_id=$1',[sourceId]),itemCount=Number(count.rows[0]?.n||0);
    await transaction(async db=>{
      await db.query(`UPDATE stremio_source_index_state SET status='ready',last_mode=$2,last_completed_at=NOW(),last_full_completed_at=CASE WHEN $2='full' THEN NOW() ELSE last_full_completed_at END,next_incremental_at=NOW()+($3||' hours')::interval,force_full=FALSE,item_count=$4,last_error=NULL,updated_at=NOW() WHERE source_id=$1`,[sourceId,mode,String(INCREMENTAL_HOURS),itemCount]);
      await db.query(`UPDATE stremio_sources SET auth_state='connected',last_success_at=NOW(),last_auth_check_at=NOW(),last_error=NULL,updated_at=NOW() WHERE id=$1`,[sourceId]);
    });
    console.log(`Stremio source index completed: ${src.name||sourceId} mode=${mode} indexed=${itemCount} changed=${changed}`);
    return{sourceId,mode,processed:changed,itemCount,startedAt,ok:true};
  }catch(error){
    const auth=error?.code==='STREMIO_SOURCE_AUTH';
    await transaction(async db=>{
      await db.query(`UPDATE stremio_source_index_state SET status='failed',last_error=$2,next_incremental_at=NOW()+INTERVAL '6 hours',updated_at=NOW() WHERE source_id=$1`,[sourceId,String(error.message||error).slice(0,1500)]).catch(()=>{});
      await db.query(`UPDATE stremio_sources SET auth_state=$2,last_auth_check_at=NOW(),last_error=$3,updated_at=NOW() WHERE id=$1`,[sourceId,auth?'reconnect_required':'error',String(error.message||error).slice(0,1000)]).catch(()=>{});
    }).catch(()=>{});
    throw error;
  }
}
async function dueSources(){const r=await query(`SELECT s.id FROM stremio_sources s JOIN stremio_source_index_state i ON i.source_id=s.id WHERE s.enabled=TRUE AND s.auth_state IN ('connected','error') AND EXISTS(SELECT 1 FROM stremio_source_libraries l WHERE l.source_id=s.id AND l.selected=TRUE AND l.available=TRUE) AND (i.status IN ('never','queued') OR i.next_incremental_at<=NOW()) ORDER BY i.force_full DESC,COALESCE(i.next_incremental_at,'1970-01-01'::timestamptz),s.priority,s.name`);return r.rows;}
async function indexDueSources(){const rows=await dueSources();let processed=0,failed=0,sources=0;for(const row of rows){sources++;try{const result=await indexSource(row.id);processed+=Number(result.processed||0);}catch(error){failed++;console.error('Stremio source index failed:',error.message);}}return{total:sources,processed,failed};}
async function lookupAll(sourceId,imdbId,itemType){const imdb=normalizeImdb(imdbId),type=itemType==='series'?'Series':'Movie';if(!imdb)return[];const r=await query(`SELECT i.*,l.name library_name,l.collection_type FROM stremio_source_media_index i LEFT JOIN stremio_source_libraries l ON l.source_id=i.source_id AND l.library_id=i.library_id WHERE i.source_id=$1 AND i.imdb_id=$2 AND i.item_type=$3 ORDER BY i.updated_at DESC,i.name`,[sourceId,imdb,type]);return r.rows;}
async function lookup(sourceId,imdbId,itemType){const rows=await lookupAll(sourceId,imdbId,itemType);return rows[0]||null;}
async function states(){const r=await query(`SELECT s.id,s.name,s.enabled,s.auth_state,s.jellyfin_username,s.base_url,s.last_connected_at,s.last_success_at,s.last_error,COALESCE(i.status,'never') index_status,COALESCE(i.item_count,0)::int item_count,i.last_mode,i.last_started_at,i.last_completed_at,i.last_full_completed_at,i.next_incremental_at,i.last_error index_error,COUNT(l.library_id) FILTER(WHERE l.selected AND l.available)::int selected_libraries FROM stremio_sources s LEFT JOIN stremio_source_index_state i ON i.source_id=s.id LEFT JOIN stremio_source_libraries l ON l.source_id=s.id GROUP BY s.id,i.source_id ORDER BY s.enabled DESC,s.priority,s.name`);return r.rows;}

module.exports={PAGE_SIZE,PAGE_DELAY_MS,INCREMENTAL_HOURS,FULL_RECONCILE_DAYS,normalizeImdb,selectedLibraries,state,queue,refreshProgress,indexSource,dueSources,indexDueSources,lookupAll,lookup,states};
