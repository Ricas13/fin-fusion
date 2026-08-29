'use strict';

const { query } = require('../db');

const SERVICES = ['jellyfin', 'stremio'];

async function get(customerId, service) {
  if (!SERVICES.includes(service)) return null;
  const result = await query(
    `SELECT network_limit FROM customer_household_overrides WHERE customer_id=$1 AND service=$2`,
    [customerId, service]
  );
  return result.rows[0] || null;
}

async function set(customerId, service, networkLimit, actorUserId = null) {
  if (!SERVICES.includes(service)) throw new Error('Unknown household service');
  const n = Number(networkLimit);
  if (!Number.isInteger(n) || n < 1 || n > 10) throw new Error('Household network limit override must be between 1 and 10');
  await query(
    `INSERT INTO customer_household_overrides(customer_id,service,network_limit,updated_by,updated_at)
     VALUES($1,$2,$3,$4,NOW())
     ON CONFLICT (customer_id,service) DO UPDATE SET network_limit=EXCLUDED.network_limit,updated_by=EXCLUDED.updated_by,updated_at=NOW()`,
    [customerId, service, n, actorUserId]
  );
}

async function reset(customerId, service) {
  if (!SERVICES.includes(service)) return;
  await query(`DELETE FROM customer_household_overrides WHERE customer_id=$1 AND service=$2`, [customerId, service]);
}

module.exports = { SERVICES, get, set, reset };
