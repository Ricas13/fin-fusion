'use strict';

const crypto=require('crypto');
const bcrypt=require('bcryptjs');
const {query,transaction}=require('../db');
const totp=require('../auth/totp');
const {keyFromEnv,encryptWithEnv,decryptWithEnv}=require('./purpose-crypto');
const emailChange=require('./customer-email-change');
const passwordPolicy=require('./customer-password-policy');

function normalizeRecovery(code){
  return String(code||'').toUpperCase().replace(/[^A-Z2-7]/g,'');
}

function recoveryHash(code){
  return crypto.createHmac('sha256',keyFromEnv('AUTH_ENCRYPTION_KEY'))
    .update(`recovery:${normalizeRecovery(code)}`)
    .digest('hex');
}

function generateRecoveryCodes(count=10){
  return Array.from({length:count},()=>{
    const raw=totp.base32Encode(crypto.randomBytes(10)).slice(0,16);
    return raw.match(/.{1,4}/g).join('-');
  });
}

async function twoFactorState(userId){
  const [user,remaining]=await Promise.all([
    query(
      `SELECT totp_enabled,totp_secret_encrypted,totp_enrolled_at,locked_until
       FROM app_users WHERE id=$1 AND role='customer'`,
      [userId]
    ),
    query(
      `SELECT COUNT(*)::int n
       FROM auth_recovery_codes
       WHERE user_id=$1 AND used_at IS NULL`,
      [userId]
    )
  ]);
  return{...(user.rows[0]||{}),recoveryRemaining:Number(remaining.rows[0]?.n||0)};
}

async function beginEnrollment(userId,{issuer='CAPTAiNFiN'}={}){
  const secret=totp.generateSecret();
  await query(
    `INSERT INTO auth_totp_enrollments(user_id,secret_encrypted,expires_at)
     VALUES($1,$2,NOW()+INTERVAL '10 minutes')
     ON CONFLICT(user_id) DO UPDATE
     SET secret_encrypted=EXCLUDED.secret_encrypted,
         expires_at=EXCLUDED.expires_at,
         created_at=NOW()`,
    [userId,encryptWithEnv(secret,'AUTH_ENCRYPTION_KEY','authv1')]
  );
  const user=(await query(
    `SELECT email,username FROM app_users WHERE id=$1 AND role='customer'`,
    [userId]
  )).rows[0];
  if(!user)throw new Error('Customer account not found.');
  return{
    secret,
    uri:totp.otpauthUri({
      secret,
      accountName:user.email||user.username||'customer',
      issuer
    })
  };
}

async function replaceRecoveryCodes(userId,client=null){
  const db=client||{query};
  const codes=generateRecoveryCodes();
  await db.query('DELETE FROM auth_recovery_codes WHERE user_id=$1',[userId]);
  for(const value of codes){
    await db.query(
      `INSERT INTO auth_recovery_codes(user_id,code_hash) VALUES($1,$2)`,
      [userId,recoveryHash(value)]
    );
  }
  return codes;
}

async function confirmEnrollment(userId,code){
  const found=await query(
    `SELECT secret_encrypted
     FROM auth_totp_enrollments
     WHERE user_id=$1 AND expires_at>NOW()`,
    [userId]
  );
  if(!found.rowCount)throw new Error('The 2FA setup session expired. Start again.');
  const secret=decryptWithEnv(found.rows[0].secret_encrypted,'AUTH_ENCRYPTION_KEY','authv1');
  if(!totp.verifyTotp(secret,String(code||'')))throw new Error('Authenticator code was not accepted.');

  return transaction(async client=>{
    const updated=await client.query(
      `UPDATE app_users
       SET totp_enabled=TRUE,
           totp_secret_encrypted=$2,
           totp_enrolled_at=NOW(),
           failed_login_count=0,
           locked_until=NULL,
           updated_at=NOW()
       WHERE id=$1 AND role='customer'
       RETURNING id`,
      [userId,encryptWithEnv(secret,'AUTH_ENCRYPTION_KEY','authv1')]
    );
    if(!updated.rowCount)throw new Error('Customer account not found.');
    const codes=await replaceRecoveryCodes(userId,client);
    await client.query('DELETE FROM auth_totp_enrollments WHERE user_id=$1',[userId]);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1::uuid,'customer.2fa.enable','app_user',$1::text,'{}'::jsonb)`,
      [userId]
    );
    return codes;
  });
}

async function regenerateRecoveryCodes(userId){
  return transaction(async client=>{
    const codes=await replaceRecoveryCodes(userId,client);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1::uuid,'customer.2fa.recovery_regenerate','app_user',$1::text,'{}'::jsonb)`,
      [userId]
    );
    return codes;
  });
}

async function disableTwoFactor(userId,currentPassword){
  await emailChange.assertPassword(userId,currentPassword);
  return transaction(async client=>{
    const updated=await client.query(
      `UPDATE app_users
       SET totp_enabled=FALSE,
           totp_secret_encrypted=NULL,
           totp_enrolled_at=NULL,
           failed_login_count=0,
           locked_until=NULL,
           updated_at=NOW()
       WHERE id=$1 AND role='customer'
       RETURNING id`,
      [userId]
    );
    if(!updated.rowCount)throw new Error('Customer account not found.');
    await client.query('DELETE FROM auth_recovery_codes WHERE user_id=$1',[userId]);
    await client.query('DELETE FROM auth_totp_enrollments WHERE user_id=$1',[userId]);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1::uuid,'customer.2fa.disable','app_user',$1::text,'{}'::jsonb)`,
      [userId]
    );
    return true;
  });
}

async function bumpSecurityVersion(userId,currentSessionId){
  return transaction(async client=>{
    const changed=await client.query(
      `UPDATE app_users
       SET session_version=session_version+1,updated_at=NOW()
       WHERE id=$1 AND role='customer'
       RETURNING session_version`,
      [userId]
    );
    if(!changed.rowCount)throw new Error('Customer account not found.');
    const version=Number(changed.rows[0].session_version);
    const others=await client.query(
      `SELECT session_id FROM auth_sessions
       WHERE user_id=$1 AND role='customer'
         AND session_id<>$2 AND revoked_at IS NULL`,
      [userId,currentSessionId]
    );
    const ids=others.rows.map(row=>row.session_id);
    await client.query(
      `UPDATE auth_sessions
       SET revoked_at=NOW()
       WHERE user_id=$1 AND role='customer'
         AND session_id<>$2 AND revoked_at IS NULL`,
      [userId,currentSessionId]
    );
    await client.query(
      `UPDATE auth_sessions
       SET session_version=$3,last_seen_at=NOW()
       WHERE user_id=$1 AND role='customer' AND session_id=$2`,
      [userId,currentSessionId,version]
    );
    if(ids.length){
      await client.query('DELETE FROM user_sessions WHERE sid=ANY($1::text[])',[ids]);
    }
    return{version,revoked:ids.length};
  });
}

async function revokeOtherSessions(userId,currentSessionId){
  return transaction(async client=>{
    const rows=await client.query(
      `SELECT session_id FROM auth_sessions
       WHERE user_id=$1 AND role='customer'
         AND session_id<>$2 AND revoked_at IS NULL`,
      [userId,currentSessionId]
    );
    const ids=rows.rows.map(row=>row.session_id);
    await client.query(
      `UPDATE auth_sessions
       SET revoked_at=NOW()
       WHERE user_id=$1 AND role='customer'
         AND session_id<>$2 AND revoked_at IS NULL`,
      [userId,currentSessionId]
    );
    if(ids.length)await client.query('DELETE FROM user_sessions WHERE sid=ANY($1::text[])',[ids]);
    return ids.length;
  });
}

async function changePassword(userId,currentPassword,newPassword,currentSessionId){
  await passwordPolicy.validateNewPassword(newPassword);
  const found=await query(
    `SELECT password_hash FROM app_users
     WHERE id=$1 AND role='customer' AND active=TRUE`,
    [userId]
  );
  if(!found.rowCount||!(await bcrypt.compare(String(currentPassword||''),found.rows[0].password_hash))){
    throw new Error('Current password was not accepted.');
  }
  if(await bcrypt.compare(newPassword,found.rows[0].password_hash)){
    throw new Error('New password must be different from the current password.');
  }
  const hash=await bcrypt.hash(newPassword,12);
  return transaction(async client=>{
    const updated=await client.query(
      `UPDATE app_users
       SET password_hash=$2,password_changed_at=NOW(),
           session_version=session_version+1,updated_at=NOW()
       WHERE id=$1 AND role='customer'
       RETURNING session_version`,
      [userId,hash]
    );
    if(!updated.rowCount)throw new Error('Customer account not found.');
    const version=Number(updated.rows[0].session_version);
    const other=await client.query(
      `SELECT session_id FROM auth_sessions
       WHERE user_id=$1 AND role='customer' AND session_id<>$2`,
      [userId,currentSessionId]
    );
    const ids=other.rows.map(row=>row.session_id);
    await client.query(
      `UPDATE auth_sessions
       SET revoked_at=NOW()
       WHERE user_id=$1 AND role='customer'
         AND session_id<>$2 AND revoked_at IS NULL`,
      [userId,currentSessionId]
    );
    await client.query(
      `UPDATE auth_sessions
       SET session_version=$3,last_seen_at=NOW()
       WHERE user_id=$1 AND role='customer' AND session_id=$2`,
      [userId,currentSessionId,version]
    );
    if(ids.length)await client.query('DELETE FROM user_sessions WHERE sid=ANY($1::text[])',[ids]);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1::uuid,'customer.password.change','app_user',$1::text,$2::jsonb)`,
      [userId,JSON.stringify({revokedSessions:ids.length})]
    );
    return{sessionVersion:version,revokedSessions:ids.length};
  });
}

async function revokeSession(userId,sessionId){
  const result=await query(
    `UPDATE auth_sessions
     SET revoked_at=COALESCE(revoked_at,NOW())
     WHERE session_id=$1 AND user_id=$2 AND role='customer'
     RETURNING session_id`,
    [sessionId,userId]
  );
  return result.rowCount===1;
}

module.exports={
  twoFactorState,
  beginEnrollment,
  confirmEnrollment,
  replaceRecoveryCodes,
  regenerateRecoveryCodes,
  disableTwoFactor,
  bumpSecurityVersion,
  revokeSession,
  revokeOtherSessions,
  changePassword
};
