'use strict';

const { transaction } = require('../db');
const permanentAccess = require('../entitlements/permanent-access');

function enabledFlag(value) {
  return ['1','true','on'].includes(String(value || '').toLowerCase());
}

function cleanReason(value) {
  return String(value || '').trim().slice(0, 500);
}

async function setAutomationProtection(customerId, { enabled, reason = '', actorUserId = null } = {}) {
  const nextEnabled = Boolean(enabled);
  const nextReason = cleanReason(reason);

  if (!nextEnabled) {
    const permanent = await permanentAccess.status(customerId);
    if (permanent?.active) {
      throw new Error('Remove permanent access before disabling automatic cleanup protection.');
    }
  }

  await transaction(async client => {
    const updated = await client.query(`
      UPDATE customers
      SET automation_protected=$2,
          automation_protected_reason=$3,
          automation_protected_at=CASE WHEN $2 THEN NOW() ELSE NULL END,
          automation_protected_by=CASE WHEN $2 THEN $4::uuid ELSE NULL END,
          updated_at=NOW()
      WHERE id=$1
      RETURNING id
    `, [
      customerId,
      nextEnabled,
      nextEnabled ? (nextReason || 'Protected by administrator') : null,
      actorUserId
    ]);
    if (!updated.rowCount) throw new Error('Customer not found.');

    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.customer.automation_protection','customer',$2,$3::jsonb)
    `, [
      actorUserId,
      customerId,
      JSON.stringify({
        enabled: nextEnabled,
        reason: nextEnabled ? (nextReason || null) : null
      })
    ]);
  });

  return { enabled: nextEnabled, reason: nextEnabled ? (nextReason || null) : null };
}

module.exports = {
  enabledFlag,
  cleanReason,
  setAutomationProtection
};
