'use strict';

require('dotenv').config();
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { pipeline } = require('stream/promises');
const { parseHeaderFromFd, requireBackupKey, TAG_BYTES } = require('../src/backup/encrypted-stream');

function run(command, args, env = process.env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', chunk => stdout.push(chunk));
    child.stderr.on('data', chunk => stderr.push(chunk));
    child.once('error', reject);
    child.once('close', code => code === 0
      ? resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') })
      : reject(new Error(`${command} exited ${code}: ${Buffer.concat(stderr).toString('utf8').slice(-3000)}`)));
  });
}

function openBackupDescriptor(filePath) {
  const noFollow = Number(fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  const stat = fs.fstatSync(fd);
  if (!stat.isFile()) {
    fs.closeSync(fd);
    throw new Error('Backup path is not a regular file.');
  }
  return { fd, stat };
}

function archiveSummary(listing) {
  const lines = String(listing || '').split(/\r?\n/).filter(Boolean);
  const tableLines = lines.filter(line => /\bTABLE\b/i.test(line) && !/\bTABLE DATA\b/i.test(line));
  const hasSchemaMigrations = lines.some(line => /\bTABLE\b.*\bschema_migrations\b/i.test(line));
  return { tableCount: tableLines.length, hasSchemaMigrations };
}

async function main() {
  const inputValue = process.argv[2];
  if (!inputValue) throw new Error('Usage: node scripts/inspect-backup.js /path/to/backup.pgdump.enc');
  const input = path.resolve(inputValue);
  if (!/\.pgdump\.enc$/i.test(input)) throw new Error('Expected a CAPTAiNFiN .pgdump.enc backup file.');

  const { fd, stat } = openBackupDescriptor(input);
  const restoreRoot = path.resolve(process.env.BACKUP_RESTORE_TMPDIR || os.tmpdir());
  fs.mkdirSync(restoreRoot, { recursive: true, mode: 0o700 });
  const tempDir = fs.mkdtempSync(path.join(restoreRoot, 'captainfin-inspect-'));
  fs.chmodSync(tempDir, 0o700);
  const plain = path.join(tempDir, 'inspect.pgdump');

  try {
    const { metadata, headerBytes, header, salt, iv } = parseHeaderFromFd(fd);
    if (stat.size <= headerBytes + TAG_BYTES) throw new Error('Encrypted backup is truncated.');
    const tag = Buffer.alloc(TAG_BYTES);
    fs.readSync(fd, tag, 0, tag.length, stat.size - tag.length);
    const key = crypto.scryptSync(requireBackupKey(), salt, 32, { N: 16384 });
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
    decipher.setAAD(header);
    decipher.setAuthTag(tag);

    await pipeline(
      fs.createReadStream(input, { fd, autoClose: false, start: headerBytes, end: stat.size - TAG_BYTES - 1 }),
      decipher,
      fs.createWriteStream(plain, { flags: 'wx', mode: 0o600 })
    );

    const { stdout } = await run(process.env.PG_RESTORE_BIN || 'pg_restore', ['--list', plain]);
    const summary = archiveSummary(stdout);
    if (!summary.hasSchemaMigrations || summary.tableCount < 5) {
      throw new Error('Backup archive does not contain the expected CAPTAiNFiN database structure.');
    }

    console.log('CAPTAiNFiN recovery-point inspection passed.');
    console.log(`Created: ${metadata.createdAt || 'unknown'}`);
    console.log(`Encrypted size: ${stat.size} bytes`);
    console.log(`Archive tables detected: ${summary.tableCount}`);
    console.log('Encryption authentication and pg_restore archive parsing both succeeded.');
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (_) {}
  }
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Backup inspection failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { archiveSummary, openBackupDescriptor };
