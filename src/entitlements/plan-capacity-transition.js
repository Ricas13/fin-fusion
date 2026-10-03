'use strict';

const { transaction } = require('../db');

const SETTING_KEY = 'plan_owned_media_capacity_v1';
const LOCK_KEY = 780031003;

/**
 * Jellyfin plan capacity_limit historically existed but was ignored. Old plans
 * therefore commonly contain 0 even while they are actively accepting users.
 *
 * Before the new code interprets capacity_limit as a real plan-owned ceiling,
 * normalize those legacy zeros to NULL exactly once. This is deliberately a
 * runtime compatibility transition rather than a schema migration: the
 * previous web generation stays healthy throughout a zero-downtime deploy.
 */
async function ensure() {
  return transaction(async client => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    const existing = await client.query(
      'SELECT setting_value FROM platform_settings WHERE setting_key=$1',
      [SETTING_KEY]
    );
    if (existing.rowCount) {
      return { applied: false, normalized: Number(existing.rows[0]?.setting_value?.normalized || 0) };
    }

    const normalized = await client.query(
      `UPDATE plans
       SET capacity_limit=NULL, updated_at=NOW()
       WHERE service_type IN ('jellyfin','bundle')
         AND capacity_limit=0
       RETURNING id`
    );

    await client.query(
      `INSERT INTO platform_settings(setting_key,setting_value,updated_at)
       VALUES($1,$2::jsonb,NOW())
       ON CONFLICT(setting_key) DO NOTHING`,
      [SETTING_KEY, JSON.stringify({
        normalized: normalized.rowCount,
        semantics: 'servers_physical_plans_acquisition',
        legacyZero: 'uncapped',
        explicitZero: 'closed'
      })]
    );
    return { applied: true, normalized: normalized.rowCount };
  });
}

module.exports = { ensure, SETTING_KEY, LOCK_KEY };
