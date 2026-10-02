'use strict';

const crypto=require('crypto');
const {transaction}=require('../db');
const emailChange=require('./customer-email-change');

const PASSWORD_TOKEN='portal_password_change';
const EMAIL_OLD_TOKEN='portal_email_old_approval';
const EMAIL_NEW_TOKEN='portal_email_new_verification';
const PASSWORD_TTL_MINUTES=30;
const EMAIL_TTL_MINUTES=24*60;

function tokenHash(raw){return crypto.createHash('sha256').update(String(raw||''),'utf8').digest('hex');}
function passwordDigest(hash){return crypto.createHash('sha256').update(String(hash||''),'utf8').digest('hex');}
function expiry(minutes){return new Date(Date.now()+minutes*60000);}
function rawToken(){return crypto.randomBytes(32).toString('base64url');}

async function revokeAllSessions(client,userId){
  const sessions=await client.query(
    `SELECT session_id FROM auth_sessions WHERE user_id=$1 AND role='customer'`,
    [userId]
  );
  const ids=sessions.rows.map(row=>row.session_id);
  await client.query(
    `UPDATE auth_sessions
     SET revoked_at=COALESCE(revoked_at,NOW())
     WHERE user_id=$1 AND role='customer'`,
    [userId]
  );
  if(ids.length)await client.query(`DELETE FROM user_sessions WHERE sid=ANY($1::text[])`,[ids]);
  return ids.length;
}

async function tokenForUpdate(client,raw,type){
  const found=await client.query(
    `SELECT * FROM account_tokens
     WHERE token_hash=$1 AND token_type=$2
       AND consumed_at IS NULL AND expires_at>NOW()
     FOR UPDATE`,
    [tokenHash(raw),type]
  );
  return found.rows[0]||null;
}

async function invalidate(client,userId,types){
  await client.query(
    `UPDATE account_tokens SET consumed_at=NOW()
     WHERE user_id=$1 AND token_type=ANY($2::text[]) AND consumed_at IS NULL`,
    [userId,types]
  );
}

async function stagePasswordChange({
  userId,
  customerId,
  expectedEmail,
  expectedPasswordHash,
  passwordHash
}){
  const raw=rawToken(),expiresAt=expiry(PASSWORD_TTL_MINUTES);
  const staged=await transaction(async client=>{
    const locked=(await client.query(
      `SELECT email,email_verified_at,password_hash
       FROM app_users
       WHERE id=$1 AND role='customer'
       FOR UPDATE`,
      [userId]
    )).rows[0];
    if(!locked||!locked.email_verified_at||!locked.email
      ||String(locked.email).toLowerCase()!==String(expectedEmail||'').toLowerCase()
      ||locked.password_hash!==expectedPasswordHash){
      throw new Error('Your account security details changed while this request was being created. Please try again.');
    }
    await invalidate(client,userId,[PASSWORD_TOKEN]);
    const approvalEmail=String(locked.email).toLowerCase();
    await client.query(
      `INSERT INTO account_tokens(user_id,token_type,token_hash,expires_at,metadata)
       VALUES($1,$2,$3,$4,$5::jsonb)`,
      [userId,PASSWORD_TOKEN,tokenHash(raw),expiresAt,JSON.stringify({
        passwordHash,
        basePasswordDigest:passwordDigest(locked.password_hash),
        approvalEmail,
        customerId
      })]
    );
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1::uuid,'customer.password_change.request','app_user',$1::text,$2::jsonb)`,
      [userId,JSON.stringify({confirmation:'verified_email',approvalEmail,expiresAt})]
    );
    return{approvalEmail};
  });
  return{...staged,raw,expiresAt};
}

async function completePasswordChange(raw){
  return transaction(async client=>{
    const token=await tokenForUpdate(client,raw,PASSWORD_TOKEN);if(!token)return null;
    const user=(await client.query(
      `SELECT password_hash,email,email_verified_at
       FROM app_users WHERE id=$1 AND role='customer' FOR UPDATE`,
      [token.user_id]
    )).rows[0];
    if(!user)return null;
    const approvalEmail=String(token.metadata?.approvalEmail||'').toLowerCase();
    if(!user.email_verified_at||!approvalEmail
      ||String(user.email||'').toLowerCase()!==approvalEmail
      ||passwordDigest(user.password_hash)!==String(token.metadata?.basePasswordDigest||'')){
      await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
      return null;
    }
    const passwordHash=String(token.metadata?.passwordHash||'');
    if(!passwordHash.startsWith('$2')){
      await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
      return null;
    }
    const updated=await client.query(
      `UPDATE app_users
       SET password_hash=$2,password_changed_at=NOW(),session_version=session_version+1,updated_at=NOW()
       WHERE id=$1 RETURNING session_version`,
      [token.user_id,passwordHash]
    );
    const revoked=await revokeAllSessions(client,token.user_id);
    await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1::uuid,'customer.password.change','app_user',$1::text,$2::jsonb)`,
      [token.user_id,JSON.stringify({
        confirmation:'verified_email',
        approvalEmail,
        revokedSessions:revoked,
        sessionVersion:Number(updated.rows[0].session_version)
      })]
    );
    return{userId:token.user_id,revoked};
  });
}

async function stageEmailChange({
  userId,
  customerId,
  expectedOldEmail,
  nextEmail,
  displayName
}){
  const raw=rawToken(),expiresAt=expiry(EMAIL_TTL_MINUTES);
  const oldEmail=String(expectedOldEmail||'').toLowerCase();
  await transaction(async client=>{
    const locked=(await client.query(
      `SELECT email,email_verified_at
       FROM app_users WHERE id=$1 AND role='customer' FOR UPDATE`,
      [userId]
    )).rows[0];
    if(!locked||!locked.email_verified_at||String(locked.email||'').toLowerCase()!==oldEmail){
      throw new Error('Your account email changed while this request was being created. Please try again.');
    }
    const duplicate=await client.query(
      `SELECT 1 FROM app_users
       WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,
      [nextEmail,userId]
    );
    if(duplicate.rowCount)throw new Error('That email address is already in use.');
    await client.query(
      `UPDATE customers SET display_name=$3,updated_at=NOW() WHERE id=$1 AND user_id=$2`,
      [customerId,userId,displayName]
    );
    await client.query(
      `UPDATE app_users SET pending_email=$2,pending_email_requested_at=NOW(),updated_at=NOW() WHERE id=$1`,
      [userId,nextEmail]
    );
    await invalidate(client,userId,[EMAIL_OLD_TOKEN,EMAIL_NEW_TOKEN,'email_change']);
    await client.query(
      `INSERT INTO account_tokens(user_id,token_type,token_hash,expires_at,metadata)
       VALUES($1,$2,$3,$4,$5::jsonb)`,
      [userId,EMAIL_OLD_TOKEN,tokenHash(raw),expiresAt,JSON.stringify({
        email:nextEmail,oldEmail,displayName,customerId
      })]
    );
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'customer.email_change.request','customer',$2,$3::jsonb)`,
      [userId,customerId,JSON.stringify({
        pendingEmail:nextEmail,approval:'old_verified_email',expiresAt
      })]
    );
  });
  return{oldEmail,nextEmail,raw,expiresAt};
}

async function approveOldEmail(raw){
  const nextRaw=rawToken(),expiresAt=expiry(EMAIL_TTL_MINUTES);
  return transaction(async client=>{
    const token=await tokenForUpdate(client,raw,EMAIL_OLD_TOKEN);if(!token)return null;
    const row=(await client.query(
      `SELECT u.email,u.email_verified_at,u.pending_email,c.id customer_id
       FROM app_users u JOIN customers c ON c.user_id=u.id
       WHERE u.id=$1 AND u.role='customer'
       FOR UPDATE OF u,c`,
      [token.user_id]
    )).rows[0];
    if(!row)return null;
    const nextEmail=emailChange.cleanEmail(token.metadata?.email);
    const oldEmail=String(token.metadata?.oldEmail||'').toLowerCase();
    if(!row.email_verified_at
      ||String(row.email||'').toLowerCase()!==oldEmail
      ||String(row.pending_email||'').toLowerCase()!==nextEmail){
      await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
      return null;
    }
    const duplicate=await client.query(
      `SELECT 1 FROM app_users
       WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,
      [nextEmail,token.user_id]
    );
    if(duplicate.rowCount)throw new Error('That email address is already in use.');
    await invalidate(client,token.user_id,[EMAIL_NEW_TOKEN]);
    await client.query(
      `INSERT INTO account_tokens(user_id,token_type,token_hash,expires_at,metadata)
       VALUES($1,$2,$3,$4,$5::jsonb)`,
      [token.user_id,EMAIL_NEW_TOKEN,tokenHash(nextRaw),expiresAt,JSON.stringify({
        ...token.metadata,email:nextEmail,oldEmail
      })]
    );
    await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'customer.email_change.old_email_approved','customer',$2,$3::jsonb)`,
      [token.user_id,row.customer_id,JSON.stringify({pendingEmail:nextEmail,expiresAt})]
    );
    return{userId:token.user_id,customerId:row.customer_id,nextEmail,oldEmail,nextRaw,expiresAt};
  });
}

async function completeNewEmail(raw){
  return transaction(async client=>{
    const token=await tokenForUpdate(client,raw,EMAIL_NEW_TOKEN);if(!token)return null;
    const row=(await client.query(
      `SELECT u.email,u.pending_email,c.id customer_id
       FROM app_users u JOIN customers c ON c.user_id=u.id
       WHERE u.id=$1 AND u.role='customer'
       FOR UPDATE OF u,c`,
      [token.user_id]
    )).rows[0];
    if(!row)return null;
    const email=emailChange.cleanEmail(token.metadata?.email);
    const oldEmail=String(token.metadata?.oldEmail||row.email||'').toLowerCase();
    if(String(row.email||'').toLowerCase()!==oldEmail
      ||String(row.pending_email||'').toLowerCase()!==email){
      await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
      return null;
    }
    const duplicate=await client.query(
      `SELECT 1 FROM app_users
       WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,
      [email,token.user_id]
    );
    if(duplicate.rowCount)throw new Error('That email address is already in use.');
    await client.query(
      `UPDATE app_users
       SET email=$2,email_verified_at=NOW(),pending_email=NULL,pending_email_requested_at=NULL,
           session_version=session_version+1,updated_at=NOW()
       WHERE id=$1`,
      [token.user_id,email]
    );
    await client.query(
      `UPDATE customers SET email=$2,updated_at=NOW() WHERE user_id=$1`,
      [token.user_id,email]
    );
    const revoked=await revokeAllSessions(client,token.user_id);
    await client.query(`UPDATE account_tokens SET consumed_at=NOW() WHERE id=$1`,[token.id]);
    await invalidate(client,token.user_id,[PASSWORD_TOKEN,EMAIL_OLD_TOKEN,'email_change']);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'customer.email_change.complete','customer',$2,$3::jsonb)`,
      [token.user_id,row.customer_id,JSON.stringify({
        email,verified:true,approval:'old_verified_email',
        newEmailVerified:true,revokedSessions:revoked
      })]
    );
    return{userId:token.user_id,customerId:row.customer_id,email,oldEmail,revoked};
  });
}

module.exports={
  PASSWORD_TOKEN,
  EMAIL_OLD_TOKEN,
  EMAIL_NEW_TOKEN,
  PASSWORD_TTL_MINUTES,
  EMAIL_TTL_MINUTES,
  tokenHash,
  passwordDigest,
  stagePasswordChange,
  completePasswordChange,
  stageEmailChange,
  approveOldEmail,
  completeNewEmail
};
