'use strict';

const bcrypt=require('bcryptjs');
const {transaction}=require('../db');
const emailChange=require('./customer-email-change');
const passwordPolicy=require('./customer-password-policy');

const RECOVERY_TOKEN_TYPES=Object.freeze([
  'portal_password_change',
  'portal_email_old_approval',
  'portal_email_new_verification',
  'email_change',
  'password_reset'
]);

async function revokeAll(client,userId){
  const sessions=await client.query(
    `SELECT session_id FROM auth_sessions WHERE user_id=$1 AND role='customer'`,
    [userId]
  );
  const ids=sessions.rows.map(row=>row.session_id);
  await client.query(
    `UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,NOW()) WHERE user_id=$1 AND role='customer'`,
    [userId]
  );
  if(ids.length)await client.query(`DELETE FROM user_sessions WHERE sid=ANY($1::text[])`,[ids]);
  return ids.length;
}

async function recover({
  customerId,
  actorUserId,
  requestedEmail='',
  password='',
  clear2fa=false,
  reason='',
  requestMeta={}
}){
  const nextEmail=requestedEmail?emailChange.cleanEmail(requestedEmail):null;
  if(password)await passwordPolicy.validateNewPassword(password);
  const passwordHash=password?await bcrypt.hash(password,12):null;

  return transaction(async client=>{
    const row=(await client.query(
      `SELECT c.id,c.user_id,u.email,u.email_verified_at,u.totp_enabled
       FROM customers c
       JOIN app_users u ON u.id=c.user_id
       WHERE c.id=$1 AND u.role='customer'
       FOR UPDATE OF c,u`,
      [customerId]
    )).rows[0];
    if(!row)throw new Error('Customer has no portal account.');

    const emailChanged=Boolean(nextEmail&&String(row.email||'').toLowerCase()!==nextEmail);
    if(emailChanged){
      const duplicate=await client.query(
        `SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,
        [nextEmail,row.user_id]
      );
      if(duplicate.rowCount)throw new Error('That portal email is already in use.');
    }
    if(!emailChanged&&!passwordHash&&!clear2fa){
      throw new Error('Choose a new portal email, a new portal password, or clear portal 2FA.');
    }

    if(emailChanged){
      await client.query(
        `UPDATE app_users
         SET email=$2,email_verified_at=NOW(),pending_email=NULL,pending_email_requested_at=NULL,updated_at=NOW()
         WHERE id=$1`,
        [row.user_id,nextEmail]
      );
      await client.query(
        `UPDATE customers SET email=$2,updated_at=NOW() WHERE id=$1`,
        [row.id,nextEmail]
      );
    }

    if(passwordHash){
      await client.query(
        `UPDATE app_users SET password_hash=$2,password_changed_at=NOW(),updated_at=NOW() WHERE id=$1`,
        [row.user_id,passwordHash]
      );
    }

    if(clear2fa){
      await client.query(
        `UPDATE app_users
         SET totp_enabled=FALSE,totp_secret_encrypted=NULL,totp_enrolled_at=NULL,
             failed_login_count=0,locked_until=NULL,updated_at=NOW()
         WHERE id=$1`,
        [row.user_id]
      );
      await client.query(`DELETE FROM auth_recovery_codes WHERE user_id=$1`,[row.user_id]);
      await client.query(`DELETE FROM auth_totp_enrollments WHERE user_id=$1`,[row.user_id]);
    }

    await client.query(
      `UPDATE app_users SET session_version=session_version+1,updated_at=NOW() WHERE id=$1`,
      [row.user_id]
    );
    const revoked=await revokeAll(client,row.user_id);
    await client.query(
      `UPDATE account_tokens
       SET consumed_at=NOW()
       WHERE user_id=$1 AND token_type=ANY($2::text[]) AND consumed_at IS NULL`,
      [row.user_id,RECOVERY_TOKEN_TYPES]
    );
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.customer.portal_credential_recovery','customer',$2,$3::jsonb)`,
      [actorUserId,row.id,JSON.stringify({
        reason,
        emailChanged,
        passwordChanged:Boolean(passwordHash),
        twoFactorCleared:Boolean(clear2fa),
        previousTwoFactorEnabled:Boolean(row.totp_enabled),
        previousEmailVerified:Boolean(row.email_verified_at),
        revokedSessions:revoked,
        ...requestMeta
      })]
    );

    return{
      oldEmail:row.email,
      oldEmailVerified:Boolean(row.email_verified_at),
      emailChanged,
      passwordChanged:Boolean(passwordHash),
      twoFactorCleared:Boolean(clear2fa),
      revoked
    };
  });
}

module.exports={recover,RECOVERY_TOKEN_TYPES};
