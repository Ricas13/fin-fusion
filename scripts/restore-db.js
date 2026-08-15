'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createDecryptionContext, requireBackupKey } = require('../src/backup/encrypted-stream');
const { postgresProcessEnv } = require('../src/backup/postgres-env');
const { getPool } = require('../src/db');
const { RESTORE_MAINTENANCE_LOCK } = require('../src/db-locks');

const CONFIRMATION = 'RESTORE_CAPTAINFIN_DATABASE';

async function acquireMaintenanceLock() {
  const client = await getPool().connect();
  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1::bigint) AS acquired',
      [RESTORE_MAINTENANCE_LOCK]
    );
    if (result.rows[0]?.acquired !== true) {
      throw new Error('Restore/maintenance lock is busy. Drain active application requests and backup operations before retrying.');
    }
    return client;
  } catch (error) {
    client.release();
    throw error;
  }
}

async function releaseMaintenanceLock(client) {
  if (!client) return;
  try {
    await client.query('SELECT pg_advisory_unlock($1::bigint)', [RESTORE_MAINTENANCE_LOCK]);
  } finally {
    client.release();
  }
}

async function run() {
  if (process.env.RESTORE_CONFIRM !== CONFIRMATION) {
    throw new Error(`Refusing destructive restore. Set RESTORE_CONFIRM=${CONFIRMATION} explicitly.`);
  }
  requireBackupKey();
  const input = process.argv[2];
  if (!input) throw new Error('Usage: npm run db:restore -- /path/to/backup.pgdump.enc');
  const backupPath = path.resolve(input);
  const { metadata, decipher, payloadStart, payloadEnd } = createDecryptionContext(backupPath);

  const tmpRoot = path.resolve(process.env.BACKUP_RESTORE_TMPDIR || os.tmpdir());
  const tmpDir = fs.mkdtempSync(path.join(tmpRoot, 'captainfin-restore-'));
  fs.chmodSync(tmpDir, 0o700);
  const dumpPath = path.join(tmpDir, 'restore.pgdump');
  let maintenanceClient = null;

  try {
    const encrypted = fs.createReadStream(backupPath, { start: payloadStart, end: payloadEnd });
    const plaintext = fs.createWriteStream(dumpPath, { flags: 'wx', mode: 0o600 });
    await pipeline(encrypted, decipher, plaintext);
    console.log(`Backup authenticated successfully (created ${metadata.createdAt}).`);

    maintenanceClient = await acquireMaintenanceLock();
    console.log('Exclusive restore/maintenance lock acquired; application mutations and backup operations are blocked.');

    const child = spawn(process.env.PG_RESTORE_BIN || 'pg_restore', [
      '--clean', '--if-exists', '--no-owner', '--no-privileges', '--exit-on-error', dumpPath
    ], {
      env: postgresProcessEnv(),
      stdio: ['ignore', 'inherit', 'pipe']
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk).slice(-8000);
      process.stderr.write(chunk);
    });
    const exitCode = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', resolve);
    });
    if (exitCode !== 0) throw new Error(`pg_restore failed with exit code ${exitCode}: ${stderr.trim()}`);
    console.log('Database restore completed successfully. Run migrations and the production readiness audit before starting application traffic.');
  } finally {
    await releaseMaintenanceLock(maintenanceClient).catch(error => console.warn(`Maintenance lock release failed: ${error.message}`));
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
    try { await getPool().end(); } catch (_) {}
  }
}

run().catch(error => {
  console.error(`Restore failed: ${error.message}`);
  process.exit(1);
});
