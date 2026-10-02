'use strict';

const {transaction}=require('../db');
const linkedProfile=require('../customers/admin-linked-profile');

async function updateAdminEmail({userId,email}){
  return transaction(async client=>{
    const current=await client.query(
      `SELECT email FROM app_users WHERE id=$1 AND role='admin' FOR UPDATE`,
      [userId]
    );
    if(!current.rowCount)throw new Error('Administrator account not found.');
    const duplicate=await client.query(
      `SELECT 1 FROM app_users WHERE lower(COALESCE(email,''))=lower($1) AND id<>$2 LIMIT 1`,
      [email,userId]
    );
    if(duplicate.rowCount)throw new Error('That email address is already used by another account.');
    const changed=String(current.rows[0].email||'').toLowerCase()!==email;
    await client.query(
      `UPDATE app_users
       SET email=$2,
           email_verified_at=CASE WHEN $3 THEN NULL ELSE email_verified_at END,
           updated_at=NOW()
       WHERE id=$1`,
      [userId,email,changed]
    );
    await linkedProfile.syncLinkedEmailTx(client,userId,email);
    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.profile.email.update','app_user',$2,$3::jsonb)`,
      [userId,String(userId),JSON.stringify({changed})]
    );
    return{changed};
  });
}

module.exports={updateAdminEmail};
