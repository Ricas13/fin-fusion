'use strict';

const { Client } = require('pg');

async function main() {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const row = (await client.query(`
      SELECT last_error,next_run_at,
             EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int AS age
      FROM backup_worker_state
      WHERE worker_key='database_backup'
    `)).rows[0];
    if (!row) process.exitCode = 1;
    else {
      const heartbeatFresh = Number(row.age) < 180;
      const operationHealthy = !row.last_error || row.next_run_at === null;
      process.exitCode = heartbeatFresh && operationHealthy ? 0 : 1;
    }
  } finally {
    await client.end();
  }
}

main().catch(() => { process.exitCode = 1; });
