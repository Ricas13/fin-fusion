'use strict';

const { query, getPool } = require('../src/db');

async function main() {
  const result = await query(`
    INSERT INTO plans(
      code,
      name,
      audience,
      billing_interval,
      duration_days,
      price_minor,
      currency,
      streams,
      server_class,
      active,
      description,
      visible,
      service_type,
      is_addon
    )
    VALUES(
      'browser-stremio-addon',
      'Browser Stremio Plan',
      'direct',
      'month',
      30,
      499,
      'GBP',
      1,
      'premium',
      TRUE,
      'Browser information-architecture regression fixture',
      TRUE,
      'stremio',
      FALSE
    )
    ON CONFLICT(code) DO UPDATE SET
      name=EXCLUDED.name,
      audience=EXCLUDED.audience,
      billing_interval=EXCLUDED.billing_interval,
      duration_days=EXCLUDED.duration_days,
      price_minor=EXCLUDED.price_minor,
      currency=EXCLUDED.currency,
      streams=EXCLUDED.streams,
      server_class=EXCLUDED.server_class,
      active=TRUE,
      description=EXCLUDED.description,
      visible=TRUE,
      service_type='stremio',
      is_addon=FALSE,
      archived_at=NULL,
      updated_at=NOW()
    RETURNING id
  `);

  if (!result.rowCount || !result.rows[0]?.id) {
    throw new Error('Could not create the admin IA Stremio plan fixture');
  }

  console.log(`admin IA fixture ready: ${result.rows[0].id}`);
}

main()
  .catch(error => {
    console.error(error.stack || error);
    process.exitCode = 1;
  })
  .finally(() => getPool().end());
