'use strict';

const {query,transaction}=require('../db');
const INDEX_JOB_KEY='captainfin:stremio_media_index';

async function running(){
  const [managed,external]=await Promise.all([
    query(`SELECT COUNT(*)::int n FROM stremio_media_index_state WHERE status='running'`),
    query(`SELECT COUNT(*)::int n FROM stremio_source_index_state WHERE status='running'`)
  ]);
  return{managed:Number(managed.rows[0]?.n||0),external:Number(external.rows[0]?.n||0)};
}
async function clearAllAndQueue(actorUserId=null){
  return transaction(async db=>{
    // automation/job-health.js owns the same advisory key while the normal
    // stremio_media_index worker runs. An xact lock here closes the race between
    // checking state and clearing the two local indexes.
    const lock=await db.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,[INDEX_JOB_KEY]);
    if(lock.rows[0]?.locked!==true)throw new Error('Stremio indexing is currently running. Wait for the current run to finish before clearing all indexes.');
    const managedRunning=await db.query(`SELECT COUNT(*)::int n FROM stremio_media_index_state WHERE status='running'`);
    const externalRunning=await db.query(`SELECT COUNT(*)::int n FROM stremio_source_index_state WHERE status='running'`);
    if(Number(managedRunning.rows[0]?.n||0)||Number(externalRunning.rows[0]?.n||0))throw new Error('A Stremio index is currently running. Wait for active indexing to finish before clearing all indexes.');
    const managedDeleted=await db.query('DELETE FROM stremio_media_index');
    const externalDeleted=await db.query('DELETE FROM stremio_source_media_index');
    await db.query(`UPDATE stremio_media_index_state SET status='never',item_count=0,last_error=NULL,updated_at=NOW()`);
    await db.query(`UPDATE stremio_source_index_state SET status='queued',next_incremental_at=NOW(),force_full=TRUE,item_count=0,last_error=NULL,updated_at=NOW()`);
    await db.query(`INSERT INTO automation_job_state(job_key,enabled,interval_seconds,next_run_at,force_run_requested,updated_at)
      VALUES('stremio_media_index',TRUE,10800,NOW(),TRUE,NOW())
      ON CONFLICT(job_key) DO UPDATE SET enabled=TRUE,interval_seconds=10800,next_run_at=NOW(),force_run_requested=TRUE,updated_at=NOW()`);
    await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.stremio.index.clear_all','stremio_runtime',NULL,$2::jsonb)`,[actorUserId,JSON.stringify({managedDeleted:managedDeleted.rowCount,externalDeleted:externalDeleted.rowCount,fullRebuildQueued:true})]);
    return{managedDeleted:managedDeleted.rowCount,externalDeleted:externalDeleted.rowCount,totalDeleted:managedDeleted.rowCount+externalDeleted.rowCount};
  });
}

module.exports={INDEX_JOB_KEY,running,clearAllAndQueue};
