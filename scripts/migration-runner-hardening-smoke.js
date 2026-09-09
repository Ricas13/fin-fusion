'use strict';

require('dotenv').config();
const assert = require('assert');
const crypto = require('crypto');
const { getPool } = require('../src/db');
const runner = require('./migrate-db');

async function main() {
  assert.throws(
    () => runner.parseArguments(['--accept-drift','040_payment_customer_identity_semantics.sql']),
    /requires --confirm-accept-drift/,
    'checksum recovery must require explicit confirmation'
  );
  assert.throws(
    () => runner.parseArguments(['--accept-drift','../evil.sql','--confirm-accept-drift']),
    /must name one migration filename/,
    'checksum recovery must reject paths'
  );

  let touched = false;
  const legacyPool = {
    async query(sql) {
      assert.match(sql, /information_schema\.tables/, 'legacy preflight must be the first database query');
      touched = true;
      return { rows: runner.BASELINE_ANCHORS.map(table_name => ({ table_name })) };
    },
    async end() {}
  };
  await assert.rejects(
    () => runner.runMigrations({ pool: legacyPool, closePool: false, argv: [] }),
    error => /predates the 2026-08-18 migration baseline squash/.test(error.message)
      && error.message.includes(runner.LEGACY_BRIDGE_COMMIT),
    'pre-squash database must stop before baseline adoption or partial migration'
  );
  assert.strictEqual(touched, true);

  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const pool = getPool();
  const client = await pool.connect();
  const filename = `zz_test_drift_${crypto.randomBytes(4).toString('hex')}.sql`;
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO schema_migrations(filename,checksum) VALUES($1,$2)`,
      [filename, 'old-checksum']
    );

    await assert.rejects(
      () => runner.verifyOrBaselineAppliedMigration(client, filename, 'new-checksum', {}),
      /Migration drift detected/,
      'checksum drift must fail closed by default'
    );
    let row = (await client.query('SELECT checksum FROM schema_migrations WHERE filename=$1',[filename])).rows[0];
    assert.strictEqual(row.checksum, 'old-checksum', 'failed drift verification must not mutate the ledger');

    const accepted = await runner.verifyOrBaselineAppliedMigration(client, filename, 'new-checksum', { acceptDrift: filename });
    assert.strictEqual(accepted.applied, true);
    assert.strictEqual(accepted.repairedDrift, true);
    row = (await client.query('SELECT checksum FROM schema_migrations WHERE filename=$1',[filename])).rows[0];
    assert.strictEqual(row.checksum, 'new-checksum', 'explicit recovery must update only the reviewed checksum');

    const audit = (await client.query(
      `SELECT metadata FROM audit_log
       WHERE action='migration.checksum_drift_accepted' AND entity_type='migration' AND entity_id=$1
       ORDER BY created_at DESC LIMIT 1`,
      [filename]
    )).rows[0];
    assert(audit, 'accepted checksum drift must have durable audit evidence in the same transaction');
    assert.strictEqual(audit.metadata?.oldChecksum, 'old-checksum');
    assert.strictEqual(audit.metadata?.newChecksum, 'new-checksum');
    assert.strictEqual(audit.metadata?.explicitOperatorConfirmation, true);

    await client.query('ROLLBACK');
    console.log('migration runner hardening smoke: ok');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
