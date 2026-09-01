'use strict';

const { Client } = require('pg');

const ownerUrl = String(process.env.DATABASE_URL || '').trim();
if (!ownerUrl) throw new Error('DATABASE_URL is required');

function runtimeUrl(role, password) {
  const url = new URL(ownerUrl);
  url.username = role;
  url.password = password;
  return url.toString();
}

const activityUrl = runtimeUrl('steamfusion_activity', 'ci-activity-runtime-role-password-2026-long-value');
process.env.ACTIVITY_DATABASE_URL = activityUrl;

const { configureRoles } = require('./configure-runtime-db-roles');

async function denied(client, sql, label) {
  let rejected = false;
  try {
    await client.query(sql);
  } catch (error) {
    if (error.code === '42501') rejected = true;
    else throw error;
  }
  if (!rejected) throw new Error(`${label} unexpectedly succeeded`);
}

async function main() {
  await configureRoles({ activityOnly: true });

  const client = new Client({ connectionString: activityUrl });
  await client.connect();
  try {
    // Representative reads from every field implicated in the household and
    // 4K policy paths. LIMIT 0 still exercises PostgreSQL privilege checks.
    await client.query(`
      SELECT customer_id,service,network_limit
      FROM customer_household_overrides
      LIMIT 0
    `);
    await client.query(`
      SELECT id,name,code,streams,active,service_type,is_free_tier,is_addon,
             jellyfin_access_model,jellyfin_household_network_limit,
             jellyfin_household_lease_minutes,kick_4k_transcodes
      FROM plans
      LIMIT 0
    `);

    // Household overrides remain configuration owned by the app/admin path.
    // The activity worker may observe them but may never mutate them.
    await denied(
      client,
      "INSERT INTO customer_household_overrides(customer_id,service,network_limit) SELECT NULL::uuid,'jellyfin',1 WHERE FALSE",
      'activity household override insert'
    );
    await denied(
      client,
      'UPDATE customer_household_overrides SET network_limit=network_limit WHERE FALSE',
      'activity household override update'
    );
    await denied(
      client,
      'DELETE FROM customer_household_overrides WHERE FALSE',
      'activity household override delete'
    );
    await denied(
      client,
      'UPDATE plans SET name=name WHERE FALSE',
      'activity plan mutation'
    );

    console.log('Activity runtime role DB smoke: ok');
  } finally {
    await client.end();
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
