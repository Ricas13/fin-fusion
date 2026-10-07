'use strict';

const assert=require('assert');
const fs=require('fs');
const path=require('path');
const read=file=>fs.readFileSync(path.join(__dirname,'..',file),'utf8');

const migration=read('db/migrations/20261002081500_stremio_zero_downtime_index_refresh.sql');
const externalShadowMigration=read('db/migrations/20261007190000_stremio_external_index_shadow.sql');
const managedIndex=read('src/stremio/media-index.js');
const externalIndex=read('src/stremio/source-index.js');
const runtimeSettings=read('src/stremio/runtime-settings.js');
const externalPlans=read('src/stremio/plan-external-sources.js');
const sourcePool=read('src/stremio/source-pool.js');
const maintenance=read('src/stremio/index-maintenance.js');
const admin=read('src/platform/admin-stremio-sources.js');
const entitlements=read('src/stremio/entitlements.js');

assert(migration.includes('CREATE TABLE IF NOT EXISTS stremio_media_index_build'),'managed refreshes need a shadow build table');
assert(migration.includes("status IN ('never','queued','running','ready','failed')"),'managed index state must support queued refreshes');
assert(migration.includes('PRIMARY KEY(generation,server_id,item_id)'),'shadow generations must be isolated by generation and server');

assert(managedIndex.includes('INSERT INTO stremio_media_index_build'),'managed scans must populate the shadow generation');
assert(managedIndex.includes('SELECT server_id,imdb_id,item_id,item_type,name,production_year,path,generation,updated_at,seen_at'),'promotion must copy one completed shadow generation into the serving table');
const promoteDelete=managedIndex.indexOf('DELETE FROM stremio_media_index WHERE server_id=$1');
const promoteInsert=managedIndex.indexOf('INSERT INTO stremio_media_index(server_id,imdb_id,item_id,item_type,name,production_year,path,scan_generation,updated_at,seen_at)',promoteDelete);
const promoteReady=managedIndex.indexOf("SET status='ready'",promoteInsert);
assert(promoteDelete>=0&&promoteInsert>promoteDelete&&promoteReady>promoteInsert,'managed promotion must flip serving rows and readiness only after the shadow build completes');
assert(managedIndex.includes('Keep last_completed_at and item_count untouched'),'a failed managed refresh must retain the previous completed snapshot');
assert(managedIndex.includes("VALUES($1,'queued',$2,NULL,NOW())"),'manual managed rebuilds must queue work without blanking readiness metadata');
assert(managedIndex.includes('return{selected,preserved,deleted:0,queued:true}'),'library changes must preserve the serving managed catalogue');
assert(managedIndex.includes("operationLock.withLock(`managed-index:${serverId}`")&&managedIndex.includes('indexServerUnlocked(serverId,options)'),'managed indexing and library mutation must share a per-server lock so an old scan cannot publish after a new selection');
assert(managedIndex.includes("const rerunRequested=state.rows[0]?.status==='queued'")&&managedIndex.includes("rerunRequested?'queued':'ready'"),'a rebuild queued during a managed scan must survive that scan completing instead of being overwritten as ready');
assert(managedIndex.includes('return{preserved,deleted:0,queued:true}'),'manual managed rebuilds must preserve the serving catalogue');

assert(!externalIndex.slice(externalIndex.indexOf('async function clearAndQueue('),externalIndex.indexOf('async function refreshProgress(')).includes('DELETE FROM stremio_source_media_index'),'manual external rebuilds must keep the previous source index live');
assert(externalShadowMigration.includes('CREATE TABLE IF NOT EXISTS public.stremio_source_media_index_build'),'external full refreshes need their own shadow generation table');
assert(externalShadowMigration.includes('PRIMARY KEY(generation,source_id,item_id)'),'external shadow generations must be isolated by generation/source/item');
assert(externalIndex.includes("operationLock.withLock(`external-token:${sourceId}`")&&externalIndex.includes('indexSourceUnlocked(sourceId,options)'),'external indexing must serialize with reconnect/rotation/disable so a stale source identity cannot publish after credentials change');
const sourcePool=read('src/stremio/source-pool.js');
assert(sourcePool.includes("operationLock.withLock(`external-token:${sourceId}`")&&sourcePool.includes('async function setLibraries(sourceId,libraryIds'),'external library-selection changes must share the source mutation/index lock and cannot race an active external scan');
assert(externalIndex.includes("if(mode==='full')")&&externalIndex.includes('INSERT INTO stremio_source_media_index_build'),'full external scans must write only to the shadow generation while serving rows remain untouched');
const externalPromoteDelete=externalIndex.indexOf("DELETE FROM stremio_source_media_index WHERE source_id=$1");
const externalPromoteInsert=externalIndex.indexOf('INSERT INTO stremio_source_media_index(source_id,library_id,imdb_id,tmdb_id,tvdb_id,title_key,item_id,item_type,name,production_year,path,date_last_saved,scan_generation,updated_at,seen_at)',externalPromoteDelete);
const externalPromoteReady=externalIndex.indexOf("SET status='ready'",externalPromoteInsert);
assert(externalPromoteDelete>=0&&externalPromoteInsert>externalPromoteDelete&&externalPromoteReady>externalPromoteInsert,'external full promotion must atomically replace serving rows before publishing the new completed snapshot');
const externalCatch=externalIndex.slice(externalIndex.indexOf('}catch(error){'),externalIndex.indexOf('function sourceBatchLimit'));
assert(externalCatch.includes("DELETE FROM stremio_source_media_index_build")&&!externalCatch.includes("DELETE FROM stremio_source_media_index WHERE source_id=$1"),'failed external full refresh must discard only its shadow generation and leave the serving snapshot intact');
assert(externalIndex.includes('preservedItems:preserved')&&externalIndex.includes('zeroDowntime:true'),'external rebuild audit metadata must record snapshot preservation');
assert(!maintenance.includes('DELETE FROM stremio_media_index')&&!maintenance.includes('DELETE FROM stremio_source_media_index'),'global rebuild must not clear serving Stremio indexes');
assert(maintenance.includes("UPDATE stremio_media_index_state SET status='queued'")&&maintenance.includes("UPDATE stremio_source_index_state SET status='queued'"),'global rebuild must queue replacements while preserving current rows');

for(const source of [runtimeSettings,externalPlans,sourcePool]){
  assert(source.includes('i.last_completed_at IS NOT NULL'),'serving eligibility must be based on a completed snapshot');
}
assert(!runtimeSettings.includes("i.status='ready' AND i.item_count>0"),'runtime readiness must not disappear merely because a refresh is running');
assert(!externalPlans.includes("i.status='ready'"),'plan source readiness must keep a completed source usable during refresh');
assert(!sourcePool.includes("i.status='ready' AND i.item_count>0"),'addon source selection must keep completed source results available during refresh');
assert(entitlements.includes('idx.last_completed_at IS NOT NULL')&&!entitlements.includes("idx.status='ready' AND idx.item_count>0"),'entitlement activation must accept the previous completed external-source snapshot while a zero-downtime refresh is queued or running');

assert(admin.includes("pill('Refreshing','accent')")&&admin.includes("pill('Preparing','accent')"),'admin UI must distinguish a live refresh from the first build');
assert(admin.includes("pill('Serving previous cache','warn')"),'failed refresh UI must make stale-but-serving behaviour explicit');
assert(admin.includes('Rebuild all indexes')&&!admin.includes('Clear all indexes & rebuild'),'operator rebuild wording must no longer imply destructive clearing');
assert(admin.includes('current catalogue stays live until the replacement is ready'),'managed library changes must explain the zero-downtime handover');

console.log('stremio zero-downtime index smoke: ok');
