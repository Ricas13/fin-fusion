'use strict';

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { configFromEnv, createS3Destination } = require('../src/backup/offsite');

async function sha256File(file) {
  const hash = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest('hex');
}

function requireInsideBackups(file) {
  const root = path.resolve(process.env.BACKUP_DIR || '/backups');
  const resolved = path.resolve(file);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Local backup path must stay inside BACKUP_DIR');
  }
  return resolved;
}

async function main(argv = process.argv.slice(2)) {
  const [command, first, second] = argv;
  const config = configFromEnv();
  if (!config.enabled) throw new Error('Off-site backups are disabled. Set BACKUP_OFFSITE_ENABLED=true after configuring the S3 destination.');
  const destination = createS3Destination(config);

  if (command === 'health') {
    await destination.health();
    console.log('Off-site backup destination is reachable.');
    return;
  }

  if (command === 'list') {
    const keys = await destination.list({ limit: Number(first || 100) });
    if (!keys.length) console.log('No encrypted off-site backups found.');
    else keys.forEach(key => console.log(key));
    return;
  }

  if (command === 'put') {
    if (!first) throw new Error('Usage: node scripts/offsite-backup.js put /backups/<file>.pgdump.enc');
    const localPath = requireInsideBackups(first);
    const stat = fs.lstatSync(localPath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Off-site upload source must be a regular non-symlink file');
    if (!localPath.endsWith('.pgdump.enc')) throw new Error('Only encrypted .pgdump.enc backup files may be uploaded');
    const checksum = await sha256File(localPath);
    const remote = await destination.put(localPath, destination.objectName(path.basename(localPath)), checksum);
    console.log(`Uploaded encrypted backup: ${remote.objectName}`);
    console.log(`SHA-256: ${checksum}`);
    return;
  }

  if (command === 'get') {
    if (!first || !second) throw new Error('Usage: node scripts/offsite-backup.js get <object-name> /backups/<file>.pgdump.enc');
    if (!String(first).startsWith(config.prefix)) throw new Error('Remote object must stay inside BACKUP_S3_PREFIX');
    const destinationPath = requireInsideBackups(second);
    if (!destinationPath.endsWith('.pgdump.enc')) throw new Error('Downloaded recovery point must use the .pgdump.enc suffix');
    fs.mkdirSync(path.dirname(destinationPath), { recursive: true, mode: 0o700 });
    await destination.get(first, destinationPath);
    console.log(`Downloaded encrypted recovery point: ${destinationPath}`);
    console.log('Run recovery.sh check before relying on this file.');
    return;
  }

  if (command === 'delete') {
    if (!first) throw new Error('Usage: node scripts/offsite-backup.js delete <object-name>');
    if (!String(first).startsWith(config.prefix)) throw new Error('Remote object must stay inside BACKUP_S3_PREFIX');
    if (process.env.BACKUP_OFFSITE_DELETE_CONFIRM !== 'DELETE_ENCRYPTED_BACKUP') {
      throw new Error('Deletion requires BACKUP_OFFSITE_DELETE_CONFIRM=DELETE_ENCRYPTED_BACKUP');
    }
    await destination.delete(first);
    console.log(`Deleted off-site backup object: ${first}`);
    return;
  }

  throw new Error('Usage: node scripts/offsite-backup.js <health|list|put|get|delete> [...]');
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Off-site backup command failed: ${error.message}`);
    process.exit(1);
  });
}

module.exports = { main, requireInsideBackups, sha256File };
