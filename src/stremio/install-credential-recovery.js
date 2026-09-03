'use strict';

const {query}=require('../db');
const {encryptWithEnv,decryptWithEnv}=require('../security/purpose-crypto');

const KEY_ENV='DATA_ENCRYPTION_KEY';
const PREFIX='stremio-install-recovery';

async function save({customerId,entitlement,credential,actorUserId=null},{client=null}={}){
  if(!customerId||!entitlement?.id||!credential)throw new Error('Stremio install credential recovery data is incomplete.');
  const tokenVersion=Number(entitlement.token_version||0);
  const encrypted=encryptWithEnv(String(credential),KEY_ENV,PREFIX);
  const db=client||{query};
  await db.query(`
    INSERT INTO stremio_install_credential_recovery(
      customer_id,entitlement_id,token_version,token_hint,credential_encrypted,issued_by_user_id,updated_at
    ) VALUES($1,$2,$3,$4,$5,$6,NOW())
    ON CONFLICT(customer_id) DO UPDATE SET
      entitlement_id=EXCLUDED.entitlement_id,
      token_version=EXCLUDED.token_version,
      token_hint=EXCLUDED.token_hint,
      credential_encrypted=EXCLUDED.credential_encrypted,
      issued_by_user_id=EXCLUDED.issued_by_user_id,
      updated_at=NOW()
  `,[customerId,entitlement.id,tokenVersion,entitlement.token_hint||null,encrypted,actorUserId||null]);
  return{tokenVersion,tokenHint:entitlement.token_hint||null};
}

async function current(customerId){
  const r=await query(`
    SELECT r.*,e.status,e.token_version current_token_version,e.token_hint current_token_hint,
           e.install_issued_at,e.last_manifest_at,e.last_stream_request_at,e.last_error
    FROM stremio_install_credential_recovery r
    JOIN stremio_entitlements e ON e.id=r.entitlement_id AND e.customer_id=r.customer_id
    WHERE r.customer_id=$1
    LIMIT 1
  `,[customerId]);
  if(!r.rowCount)return null;
  const row=r.rows[0];
  if(row.status!=='active'||Number(row.current_token_version)!==Number(row.token_version))return null;
  if(String(row.current_token_hint||'')!==String(row.token_hint||''))return null;
  try{
    return{...row,credential:decryptWithEnv(row.credential_encrypted,KEY_ENV,PREFIX)};
  }catch(error){
    // An unreadable recovery copy is safe to replace with a freshly-issued
    // install token, but the key/data mismatch must remain visible to operators.
    console.warn('Stremio install credential recovery decrypt failed.',{
      customerId,
      error:String(error?.message||error).replace(/[\r\n\t]+/g,' ').slice(0,300)
    });
    return null;
  }
}

async function clear(customerId){
  const r=await query(`DELETE FROM stremio_install_credential_recovery WHERE customer_id=$1 RETURNING customer_id`,[customerId]);
  return r.rowCount;
}

module.exports={save,current,clear,KEY_ENV,PREFIX};