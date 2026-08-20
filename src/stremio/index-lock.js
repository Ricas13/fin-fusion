'use strict';

const {getPool}=require('../db');
const {RESTORE_MAINTENANCE_LOCK}=require('../db-locks');

const INDEX_JOB_KEY='captainfin:stremio_media_index';

async function withIndexTransaction(fn,{busyMessage='Stremio indexing is currently running. Wait for the current run to finish and try again.'}={}){
  const client=await getPool().connect();
  let begun=false;
  try{
    await client.query('BEGIN');
    begun=true;
    await client.query('SELECT pg_advisory_xact_lock_shared($1::bigint)',[RESTORE_MAINTENANCE_LOCK]);
    const result=await client.query(`SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked`,[INDEX_JOB_KEY]);
    if(result.rows[0]?.locked!==true)throw new Error(busyMessage);
    const value=await fn(client);
    await client.query('COMMIT');
    begun=false;
    return value;
  }catch(error){
    if(begun)await client.query('ROLLBACK').catch(()=>{});
    throw error;
  }finally{
    client.release();
  }
}

module.exports={INDEX_JOB_KEY,withIndexTransaction};
