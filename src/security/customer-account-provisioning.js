'use strict';

async function createPendingCustomerUserTx(client,{username,email,passwordHash}){
  if(!client?.query)throw new Error('A database transaction client is required.');
  const exists=await client.query(
    `SELECT 1 FROM app_users
     WHERE lower(username)=lower($1)
        OR lower(COALESCE(email,''))=lower($2)`,
    [username,email]
  );
  if(exists.rowCount)throw Object.assign(new Error('exists'),{code:'23505'});
  const user=await client.query(
    `INSERT INTO app_users(email,username,password_hash,role,active,email_verified_at)
     VALUES($1,$2,$3,'customer',FALSE,NOW())
     RETURNING id`,
    [email,username,passwordHash]
  );
  return user.rows[0];
}

module.exports={createPendingCustomerUserTx};
