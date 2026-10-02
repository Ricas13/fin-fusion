'use strict';

const { transaction } = require('../db');

async function verifyEmail(customerId, { actorUserId = null } = {}) {
  return transaction(async client => {
    const result = await client.query(`
      SELECT c.user_id,u.email_verified_at
      FROM customers c
      JOIN app_users u ON u.id=c.user_id
      WHERE c.id=$1
      FOR UPDATE
    `, [customerId]);
    if (!result.rowCount) throw new Error('Customer not found.');

    const row = result.rows[0];
    await client.query(`
      UPDATE app_users
      SET email_verified_at=COALESCE(email_verified_at,NOW()),updated_at=NOW()
      WHERE id=$1
    `, [row.user_id]);

    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.email.verify','customer',$2,$3::jsonb)
    `, [actorUserId, customerId, JSON.stringify({
      manual: true,
      wasVerified: Boolean(row.email_verified_at)
    })]);

    return { userId: row.user_id, wasVerified: Boolean(row.email_verified_at) };
  });
}

module.exports = { verifyEmail };
