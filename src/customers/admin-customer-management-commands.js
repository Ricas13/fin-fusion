'use strict';

const {query,transaction}=require('../db');

async function audit(client,actorUserId,action,customerId,metadata={}){
  await client.query(
    `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
     VALUES($1,$2,'customer',$3,$4::jsonb)`,
    [actorUserId,action,customerId,JSON.stringify(metadata)]
  );
}

async function enrolPortal({customerId,username,email,passwordHash,actorUserId=null}){
  return transaction(async client=>{
    const customer=(await client.query(
      `SELECT id,user_id FROM customers WHERE id=$1 FOR UPDATE`,
      [customerId]
    )).rows[0];
    if(!customer)throw new Error('Customer not found.');
    if(customer.user_id)throw new Error('This customer already has a portal account.');

    const exists=await client.query(
      `SELECT 1 FROM app_users
       WHERE lower(username)=lower($1)
          OR lower(COALESCE(email,''))=lower($2)`,
      [username,email]
    );
    if(exists.rowCount)throw Object.assign(new Error('That username or email already exists.'),{code:'23505'});

    const user=(await client.query(
      `INSERT INTO app_users(email,username,password_hash,role,active,email_verified_at)
       VALUES($1,$2,$3,'customer',FALSE,NULL)
       RETURNING id`,
      [email,username,passwordHash]
    )).rows[0];

    await client.query(
      `UPDATE customers SET user_id=$2,email=$3,updated_at=NOW() WHERE id=$1`,
      [customerId,user.id,email]
    );
    await audit(client,actorUserId,'admin.customer.portal.enrol',customerId,{userId:user.id,username,email});
    return user.id;
  });
}

async function updateAccount(customerId,input,{actorUserId=null}={}){
  return transaction(async client=>{
    const row=(await client.query(
      `SELECT c.*,u.username login_username,u.email login_email
       FROM customers c
       LEFT JOIN app_users u ON u.id=c.user_id
       WHERE c.id=$1
       FOR UPDATE OF c`,
      [customerId]
    )).rows[0];
    if(!row)throw new Error('Customer not found.');

    let emailChanged=false,usernameChanged=false;
    if(row.user_id){
      if(!/^[A-Za-z0-9._-]{3,40}$/.test(input.username)||!input.email.includes('@')){
        throw new Error('Check the portal username and email.');
      }
      emailChanged=String(row.login_email||'').toLowerCase()!==input.email;
      usernameChanged=String(row.login_username||'')!==input.username;
      await client.query(
        `UPDATE app_users
         SET username=$2,
             email=$3,
             email_verified_at=CASE WHEN lower(COALESCE(email,''))<>lower($3) THEN NULL ELSE email_verified_at END,
             updated_at=NOW()
         WHERE id=$1`,
        [row.user_id,input.username,input.email]
      );
    }

    await client.query(
      `UPDATE customers
       SET display_name=$2,
           email=COALESCE($3,email),
           phone=$4,
           country_code=$5,
           timezone=$6,
           discord_user_id=$7,
           discord_username=$8,
           referral_source=$9,
           registration_source=$10,
           tags=$11::text[],
           note=$12,
           updated_at=NOW()
       WHERE id=$1`,
      [
        customerId,input.displayName,row.user_id?input.email:null,input.phone,input.countryCode||null,
        input.timezone,input.discordUserId,input.discordUsername,input.referralSource,
        input.registrationSource,input.tags,input.note
      ]
    );
    await audit(client,actorUserId,'admin.customer.account.update',customerId,{emailChanged,usernameChanged,profileUpdated:true});
    return{emailChanged,usernameChanged};
  });
}

async function setEmailVerified(customerId,verified,{actorUserId=null}={}){
  return transaction(async client=>{
    const row=(await client.query(
      `SELECT user_id FROM customers WHERE id=$1 FOR UPDATE`,
      [customerId]
    )).rows[0];
    if(!row?.user_id)throw new Error(verified?'Customer has no portal account to verify.':'Customer has no portal account.');
    if(verified){
      await client.query(
        `UPDATE app_users SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW() WHERE id=$1`,
        [row.user_id]
      );
    }else{
      await client.query(
        `UPDATE app_users SET email_verified_at=NULL,updated_at=NOW() WHERE id=$1`,
        [row.user_id]
      );
    }
    await audit(client,actorUserId,verified?'admin.customer.email.verify':'admin.customer.email.unverify',customerId,{manual:true});
    return true;
  });
}

async function portalUserId(customerId){
  const row=(await query(`SELECT user_id FROM customers WHERE id=$1`,[customerId])).rows[0];
  return row?.user_id||null;
}

async function setActivationDeadline(customerId,expiresAt){
  const result=await query(
    `UPDATE customers SET activation_deadline=$2,updated_at=NOW() WHERE id=$1 RETURNING id`,
    [customerId,expiresAt]
  );
  if(!result.rowCount)throw new Error('Customer not found.');
  return true;
}

async function setPortalStatus(customerId,active,{actorUserId=null}={}){
  return transaction(async client=>{
    const row=(await client.query(
      `SELECT c.user_id,u.password_changed_at,u.active
       FROM customers c
       JOIN app_users u ON u.id=c.user_id
       WHERE c.id=$1
       FOR UPDATE OF u`,
      [customerId]
    )).rows[0];
    if(!row)throw new Error('Customer has no portal account.');
    if(active&&!row.password_changed_at){
      throw new Error('Customer has not completed onboarding yet. Use the onboarding link instead of enabling an inaccessible account.');
    }

    let revokedActivationLinks=0;
    if(!active){
      const revoked=await client.query(
        `UPDATE account_activation_tokens
         SET revoked_at=NOW()
         WHERE user_id=$1
           AND purpose='customer_activation'
           AND used_at IS NULL
           AND revoked_at IS NULL`,
        [row.user_id]
      );
      revokedActivationLinks=revoked.rowCount;
    }

    await client.query(
      `UPDATE app_users
       SET active=$2,session_version=session_version+1,updated_at=NOW()
       WHERE id=$1`,
      [row.user_id,Boolean(active)]
    );
    await audit(
      client,actorUserId,
      active?'admin.customer.portal.enable':'admin.customer.portal.disable',
      customerId,
      {previousActive:Boolean(row.active),revokedActivationLinks}
    );
    return{previousActive:Boolean(row.active),revokedActivationLinks};
  });
}

module.exports={
  enrolPortal,
  updateAccount,
  setEmailVerified,
  portalUserId,
  setActivationDeadline,
  setPortalStatus
};
