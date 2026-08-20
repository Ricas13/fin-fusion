'use strict';

const {getPool}=require('../db');

const INDEX_JOB_KEY='captainfin:stremio_media_index';

async function withIndexLock(fn,{busyMessage='Stremio indexing is currently running. Wait for the current run to finish and try again.'}={}){
  const client=await getPool().connect();
  let locked=false;
  try{
    const result=await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS locked`,[INDEX_JOB_KEY]);
    locked=Boolean(result.rows[0]?.locked);
    if(!locked)throw new Error(busyMessage);
    return await fn();
  }finally{
    if(locked)await client.query(`SELECT pg_advisory_unlock(hashtext($1))`,[INDEX_JOB_KEY]).catch(()=>{});
    client.release();
  }
}

module.exports={INDEX_JOB_KEY,withIndexLock};
