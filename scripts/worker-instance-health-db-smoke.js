'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { getPool } = require('../src/db');

(async () => {
  const pool = getPool();
  const client = await pool.connect();
  const workerKey = `health-smoke-${crypto.randomUUID()}`;
  try {
    await client.query('BEGIN');
    await client.query(`
      INSERT INTO operational_worker_state(worker_key,instance_id,version,commit_sha,started_at,last_heartbeat_at,metadata,updated_at)
      VALUES
        ($1,'live-a','1.4.0','aaa',NOW()-INTERVAL '2 minutes',NOW()-INTERVAL '5 seconds','{}'::jsonb,NOW()),
        ($1,'live-b','1.4.1','bbb',NOW()-INTERVAL '1 minute',NOW()-INTERVAL '10 seconds','{}'::jsonb,NOW()),
        ($1,'stale-old','1.3.0','old',NOW()-INTERVAL '3 days',NOW()-INTERVAL '2 days','{}'::jsonb,NOW())
    `, [workerKey]);

    const before = await client.query('SELECT instance_id FROM operational_worker_state WHERE worker_key=$1 ORDER BY instance_id', [workerKey]);
    assert.deepStrictEqual(before.rows.map(row => row.instance_id), ['live-a', 'live-b', 'stale-old'], 'same-role worker instances must persist separately');

    await client.query("SELECT public.prune_operational_worker_instances(interval '24 hours')");
    const after = await client.query('SELECT instance_id FROM operational_worker_state WHERE worker_key=$1 ORDER BY instance_id', [workerKey]);
    assert.deepStrictEqual(after.rows.map(row => row.instance_id), ['live-a', 'live-b'], 'stale worker instance must expire while live instances remain');

    await client.query('ROLLBACK');
    console.log('worker instance health DB smoke: ok');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
