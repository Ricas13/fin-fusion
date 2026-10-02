'use strict';

const { transaction } = require('../db');

async function applyImportedPreferences(client, items = [], actorUserId = null) {
  let count = 0;
  for (const item of items) {
    await client.query(
      `INSERT INTO notification_preferences(
         event_type,telegram_enabled,email_enabled,updated_by,updated_at
       ) VALUES($1,$2,$3,$4,NOW())
       ON CONFLICT(event_type) DO UPDATE SET
         telegram_enabled=EXCLUDED.telegram_enabled,
         email_enabled=EXCLUDED.email_enabled,
         updated_by=EXCLUDED.updated_by,
         updated_at=NOW()`,
      [item.event_type, item.telegram_enabled, item.email_enabled, actorUserId]
    );
    count += 1;
  }
  return count;
}

async function saveGlobalPreferences(items = [], actorUserId = null) {
  return transaction(async client => {
    for (const item of items) {
      await client.query(
        `UPDATE notification_preferences
         SET email_enabled=$2,
             telegram_enabled=$3,
             discord_enabled=$4,
             customer_opt_in_allowed=$5,
             updated_by=$6,
             updated_at=NOW()
         WHERE event_type=$1`,
        [
          item.eventType,
          Boolean(item.emailEnabled),
          Boolean(item.telegramEnabled),
          Boolean(item.discordEnabled),
          Boolean(item.customerOptInAllowed),
          actorUserId
        ]
      );
    }

    await client.query(
      `INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
       VALUES($1,'admin.notifications.global.update','notification_preferences','all',$2::jsonb)`,
      [actorUserId, JSON.stringify({ eventCount: items.length })]
    );

    return { eventCount: items.length };
  });
}

module.exports = {
  applyImportedPreferences,
  saveGlobalPreferences
};
