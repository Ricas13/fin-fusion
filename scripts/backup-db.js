'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { createEncryptionContext, requireBackupKey } = require('../src/backup/encrypted-stream');
const { postgresProcessEnv } = require('../src/backup/postgres-env');

async function main() {
  requireBackupKey();
  const outDir = path.resolve(process.env.BACKUP_DIR || './backups');
  fs.mkdirSync(outDir, { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const finalPath = path.join(outDir, `captainfin-${stamp}.pgdump.enc`);
  const tempPath = `${finalPath}.tmp-${process.pid}`;
  const { header, cipher } = createEncryptionContext();
  const out = fs.createWriteStream(tempPath, { flags: 'wx', mode: 0o600 });
  out.write(header);

  const child = spawn(process.env.PG_DUMP_BIN || 'pg_dump', [
    '--format=custom', '--no-owner', '--no-privileges'
  ], {
    env: postgresProcessEnv(),
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const childExit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });

  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });

  try {
    await pipeline(child.stdout, cipher, out, { end: false });
    const exitCode = await childExit;
    if (exitCode !== 0) throw new Error(`pg_dump failed with exit code ${exitCode}: ${stderr.trim()}`);
    out.write(cipher.getAuthTag());
    await new Promise((resolve, reject) => {
      out.once('error', reject);
      out.end(resolve);
    });
    fs.renameSync(tempPath, finalPath);
    console.log(`Encrypted database backup created: ${finalPath}`);
  } catch (error) {
    child.kill('SIGTERM');
    out.destroy();
    try { fs.unlinkSync(tempPath); } catch (_) {}
    throw error;
  }
}

main().catch(error => {
  console.error(`Backup failed: ${error.message}`);
  process.exit(1);
});
