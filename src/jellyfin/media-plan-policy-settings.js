'use strict';

const { query, transaction } = require('../db');

const KEY_PREFIX = 'media_plan_policy_v1:';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULTS = Object.freeze({
  ipLimit: null,
  deviceLimit: null,
  paygExpiryMessagesEnabled: true
});

function planId(value) {
  const id = String(value || '').trim();
  if (!UUID.test(id)) throw new Error('A valid plan ID is required.');
  return id;
}
function keyFor(id) { return `${KEY_PREFIX}${planId(id)}`; }
function optionalLimit(value, max = 200) {
  if (value === null || value === undefined || String(value).trim() === '' || String(value).trim() === '0') return null;
  const parsed = Number.parseInt(String(value).trim(), 10);
  if (!Number.isInteger(parsed) || String(parsed) !== String(value).trim() || parsed < 1 || parsed > max) {
    throw new Error(`Limit must be 0 for unlimited or a whole number from 1 to ${max}.`);
  }
  return parsed;
}
function enabled(value, fallback = true) {
  if (value === undefined || value === null) return fallback;
  return value === true || ['1', 'true', 'on', 'yes'].includes(String(value).toLowerCase());
}
function normalize(value = {}) {
  return {
    ipLimit: optionalLimit(value.ipLimit),
    deviceLimit: optionalLimit(value.deviceLimit),
    paygExpiryMessagesEnabled: enabled(value.paygExpiryMessagesEnabled, true)
  };
}

async function get(id) {
  const key = keyFor(id);
  const result = await query('SELECT setting_value FROM platform_settings WHERE setting_key=$1', [key]);
  return { ...DEFAULTS, ...normalize({ ...DEFAULTS, ...(result.rows[0]?.setting_value || {}) }) };
}

async function getMany(ids) {
  const unique = [...new Set((ids || []).map(value => String(value || '').trim()).filter(value => UUID.test(value)))];
  const map = new Map(unique.map(id => [id, { ...DEFAULTS }]));
  if (!unique.length) return map;
  const keys = unique.map(id => `${KEY_PREFIX}${id}`);
  const result = await query('SELECT setting_key,setting_value FROM platform_settings WHERE setting_key=ANY($1::text[])', [keys]);
  for (const row of result.rows) {
    const id = String(row.setting_key || '').slice(KEY_PREFIX.length);
    if (!map.has(id)) continue;
    map.set(id, { ...DEFAULTS, ...normalize({ ...DEFAULTS, ...(row.setting_value || {}) }) });
  }
  return map;
}

async function save(id, input, actorUserId = null) {
  const normalizedId = planId(id);
  const value = normalize(input);
  await transaction(async client => {
    await client.query(`
      INSERT INTO platform_settings(setting_key,setting_value)
      VALUES($1,$2::jsonb)
      ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()
    `, [keyFor(normalizedId), JSON.stringify(value)]);
    await client.query(`
      INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata)
      VALUES($1,'admin.plan.media_connection_policy','plan',$2,$3::jsonb)
    `, [actorUserId, normalizedId, JSON.stringify(value)]);
  });
  return value;
}

module.exports = { KEY_PREFIX, DEFAULTS, normalize, optionalLimit, get, getMany, save, keyFor };
