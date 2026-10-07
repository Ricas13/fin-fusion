'use strict';

const {query,transaction}=require('../db');
const operationLock=require('./operation-lock');
const externalPlaybackToken=require('./external-playback-token');

function priority(value){
  const parsed=Number.parseInt(value,10);
  if(!Number.isInteger(parsed)||parsed<1||parsed>10000)throw new Error('Stremio source priority must be between 1 and 10000.');
  return parsed;
}

async function configure({sourceId,enabled,sourcePriority,actorUserId=null}){
  const nextPriority=priority(sourcePriority||100),target=Boolean(enabled);
  return operationLock.withLock(`external-token:${sourceId}`,async()=>{
    const current=await query('SELECT id,name,enabled FROM stremio_sources WHERE id=$1',[sourceId]);
    if(!current.rowCount)throw new Error('Stremio source not found.');
    if(current.rows[0].enabled&& !target)await externalPlaybackToken.revokeSource(sourceId);
    await transaction(async db=>{
      const locked=await db.query('SELECT id,name FROM stremio_sources WHERE id=$1 FOR UPDATE',[sourceId]);
      if(!locked.rowCount)throw new Error('Stremio source not found.');
      await db.query('UPDATE stremio_sources SET enabled=$2,priority=$3,updated_at=NOW() WHERE id=$1',[sourceId,target,nextPriority]);
      await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
        VALUES($1,'admin.stremio.source.configure','stremio_source',$2,$3::jsonb)`,[
        actorUserId,sourceId,JSON.stringify({enabled:target,priority:nextPriority})
      ]);
    });
  });
}

module.exports={priority,configure};
