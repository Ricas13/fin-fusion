'use strict';

const {query,transaction}=require('../db');
const client=require('./source-client');
const operationLock=require('./operation-lock');

const DEFAULT_ROTATION_HOURS=4;
const TOKEN_GRACE_HOURS=1;

function rotationHours(value){return Math.max(1,Math.min(168,Number.parseInt(value,10)||DEFAULT_ROTATION_HOURS));}
function graceHours(value){return Math.max(1,Math.min(24,Number.parseInt(value,10)||TOKEN_GRACE_HOURS));}

async function cleanupIssuedAuth(auth,{sourceName='Media server',mediaServerType=null}={}){
  if(!auth?.baseUrl||!auth?.accessToken)return false;
  try{return await client.logoutToken(auth.baseUrl,auth.accessToken,sourceName||'Media server',mediaServerType||auth.mediaServerType||'jellyfin');}
  catch(error){console.error(`Stremio newly issued token cleanup failed for ${sourceName||'Media server'}:`,error.message);return false;}
}

async function retireEncryptedTokenTx(db,source,{encryptedToken=null,actorUserId=null,reason='rotation',grace=TOKEN_GRACE_HOURS}={}){
  const token=encryptedToken||source?.access_token_encrypted;
  if(!source?.id||!source?.base_url||!token)return false;
  const hours=graceHours(grace);
  const inserted=await db.query(`INSERT INTO stremio_source_retired_tokens(source_id,base_url,source_name,token_encrypted,revoke_at)
    SELECT $1,$2,$3,$4,NOW()+($5||' hours')::interval
    WHERE NOT EXISTS(
      SELECT 1 FROM stremio_source_retired_tokens
      WHERE source_id=$1 AND token_encrypted=$4
    ) RETURNING id`,[source.id,source.base_url,source.name||null,token,String(hours)]);
  if(inserted.rowCount)await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
    VALUES($1,'admin.stremio.source.token_retired','stremio_source',$2,$3::jsonb)`,[actorUserId,source.id,JSON.stringify({reason,graceHours:hours})]);
  return Boolean(inserted.rowCount);
}

async function retireEncryptedToken(source,options={}){
  return transaction(db=>retireEncryptedTokenTx(db,source,options));
}

async function rotateSourceToken(source,actorUserId=null){
  if(!source?.id)throw new Error('External Stremio source id is required for token rotation.');
  return operationLock.withLock(`external-token:${source.id}`,async()=>{
    const currentResult=await query('SELECT * FROM stremio_sources WHERE id=$1',[source.id]);
    if(!currentResult.rowCount)throw new Error('External Stremio source no longer exists.');
    const current=currentResult.rows[0];
    if(source.access_token_encrypted&&current.access_token_encrypted!==source.access_token_encrypted)return{sourceId:source.id,ok:true,skipped:true,reason:'already_rotated'};
    if(!current.password_encrypted)throw new Error('Automatic token rotation requires an encrypted source password. Reconnect this source and enable token rotation.');
    if(!current.access_token_encrypted)throw new Error('External Jellyfin source has no current token to rotate.');
    const password=client.decryptPassword(current.password_encrypted);
    const auth=await client.authenticate(current.base_url,current.jellyfin_username,password,current.media_server_type||null);
    const encrypted=client.encryptToken(auth.accessToken),hours=rotationHours(current.token_rotation_hours);
    try{
      await transaction(async db=>{
        const locked=await db.query('SELECT * FROM stremio_sources WHERE id=$1 FOR UPDATE',[current.id]);
        if(!locked.rowCount)throw new Error('External Stremio source disappeared during token rotation.');
        const latest=locked.rows[0];
        if(latest.access_token_encrypted!==current.access_token_encrypted)throw new Error('External Stremio source token changed during rotation; retry from current state.');
        await retireEncryptedTokenTx(db,latest,{actorUserId,reason:'rotation',grace:TOKEN_GRACE_HOURS});
        await db.query(`UPDATE stremio_sources SET public_url=$2,jellyfin_user_id=$3,jellyfin_username=$4,access_token_encrypted=$5,
          auth_state='connected',last_connected_at=NOW(),last_auth_check_at=NOW(),last_success_at=NOW(),last_error=NULL,
          token_last_rotated_at=NOW(),token_rotates_at=NOW()+($6||' hours')::interval,updated_at=NOW() WHERE id=$1`,
          [latest.id,auth.publicUrl,auth.jellyfinUserId,auth.jellyfinUsername,encrypted,String(hours)]);
        await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
          VALUES($1,'admin.stremio.source.token_rotate','stremio_source',$2,$3::jsonb)`,[actorUserId,latest.id,JSON.stringify({jellyfinUsername:auth.jellyfinUsername,tokenRotationHours:hours,oldTokenGraceHours:TOKEN_GRACE_HOURS})]);
      });
    }catch(error){
      await cleanupIssuedAuth(auth,{sourceName:current.name||current.jellyfin_username,mediaServerType:current.media_server_type});
      throw error;
    }
    return{sourceId:current.id,ok:true,rotationHours:hours,graceHours:TOKEN_GRACE_HOURS};
  });
}

async function rotateDueTokens({limit=25}={}){
  const rows=(await query(`SELECT * FROM stremio_sources
    WHERE enabled=TRUE AND token_rotation_enabled=TRUE AND password_encrypted IS NOT NULL
      AND (token_rotates_at IS NULL OR token_rotates_at<=NOW())
    ORDER BY COALESCE(token_rotates_at,'1970-01-01'::timestamptz),priority,name LIMIT $1`,[Math.max(1,Math.min(100,Number(limit)||25))])).rows;
  let rotated=0,failed=0,skipped=0;
  for(const source of rows){
    try{const result=await rotateSourceToken(source);if(result?.skipped)skipped++;else rotated++;}
    catch(error){failed++;await query(`UPDATE stremio_sources SET auth_state='error',last_auth_check_at=NOW(),last_error=$2,token_rotates_at=NOW()+INTERVAL '1 hour',updated_at=NOW() WHERE id=$1`,[source.id,String(error.message||error).slice(0,1000)]).catch(()=>{});console.error(`Stremio source token rotation failed for ${source.name}:`,error.message);}
  }
  return{total:rows.length,rotated,skipped,failed};
}

async function revokeRetiredTokens({limit=100,sourceId=null,force=false}={}){
  const rows=(await query(`SELECT * FROM stremio_source_retired_tokens
    WHERE ($1::uuid IS NULL OR source_id=$1) AND ($2::boolean=TRUE OR revoke_at<=NOW())
    ORDER BY revoke_at,id LIMIT $3`,[sourceId||null,Boolean(force),Math.max(1,Math.min(1000,Number(limit)||100))])).rows;
  let revoked=0,failed=0;
  for(const row of rows){
    try{
      const token=client.decryptToken(row.token_encrypted),ok=await client.logoutToken(row.base_url,token,row.source_name||'Jellyfin');
      if(!ok)throw new Error('Jellyfin did not confirm retired token logout.');
      await transaction(async db=>{
        await db.query('DELETE FROM stremio_source_retired_tokens WHERE id=$1',[row.id]);
        await db.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
          VALUES(NULL,'system.stremio.source.token_revoked','stremio_source',$1,$2::jsonb)`,[row.source_id,JSON.stringify({retiredTokenId:row.id,graceComplete:true})]);
      });
      revoked++;
    }catch(error){
      failed++;
      await query(`UPDATE stremio_source_retired_tokens SET last_attempt_at=NOW(),attempt_count=attempt_count+1,last_error=$2,revoke_at=NOW()+INTERVAL '1 hour' WHERE id=$1`,[row.id,String(error.message||error).slice(0,1000)]).catch(()=>{});
      console.error(`Stremio retired token revocation failed for ${row.source_name||row.source_id}:`,error.message);
    }
  }
  return{total:rows.length,revoked,failed};
}

async function maintain({rotateLimit=25,revokeLimit=100}={}){
  const revocation=await revokeRetiredTokens({limit:revokeLimit});
  const rotation=await rotateDueTokens({limit:rotateLimit});
  return{total:Number(revocation.total||0)+Number(rotation.total||0),processed:Number(revocation.revoked||0)+Number(rotation.rotated||0),failed:Number(revocation.failed||0)+Number(rotation.failed||0),rotation,revocation};
}

module.exports={DEFAULT_ROTATION_HOURS,TOKEN_GRACE_HOURS,rotationHours,graceHours,cleanupIssuedAuth,retireEncryptedTokenTx,retireEncryptedToken,rotateSourceToken,rotateDueTokens,revokeRetiredTokens,maintain};
