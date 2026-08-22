'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  EMPTY_SHA256,
  configFromEnv,
  createS3Destination,
  normalizePrefix,
  objectName,
  parseKeys,
  requestUrl,
  signingHeaders,
  validateEndpoint
} = require('../src/backup/offsite');
const { deriveRecoveryReadiness } = require('../src/platform/backup-recovery-readiness');
const { requireInsideBackups } = require('./offsite-backup');

const root = path.join(__dirname, '..');

assert.strictEqual(configFromEnv({}).enabled, false, 'off-site backups must default off');
assert.throws(() => validateEndpoint('http://storage.example'), /HTTPS/i, 'plaintext object storage must be rejected');
assert.throws(() => validateEndpoint('https://user:pass@storage.example'), /credentials/i, 'credentials must not be embedded in endpoint URLs');
assert.strictEqual(normalizePrefix('/captainfin/database/'), 'captainfin/database/');

const config = configFromEnv({
  BACKUP_OFFSITE_ENABLED: 'true',
  BACKUP_OFFSITE_PROVIDER: 's3',
  BACKUP_S3_ENDPOINT: 'https://objects.example.test',
  BACKUP_S3_REGION: 'eu-west-2',
  BACKUP_S3_BUCKET: 'captainfin-backups',
  BACKUP_S3_ACCESS_KEY_ID: 'fixture-access-key',
  BACKUP_S3_SECRET_ACCESS_KEY: 'fixture-secret-key-that-must-not-leak',
  BACKUP_S3_PREFIX: 'captainfin/',
  BACKUP_S3_FORCE_PATH_STYLE: 'true',
  BACKUP_S3_MAX_ATTEMPTS: '3'
});
assert.strictEqual(config.enabled, true);
assert.strictEqual(config.maxAttempts, 3);
assert.strictEqual(objectName(config, '/tmp/captainfin-test.pgdump.enc'), 'captainfin/captainfin-test.pgdump.enc');
const url = requestUrl(config, 'captainfin/captainfin-test.pgdump.enc');
assert.strictEqual(url.protocol, 'https:');
assert.strictEqual(url.pathname, '/captainfin-backups/captainfin/captainfin-test.pgdump.enc');

const headers = signingHeaders(config, {
  method: 'GET',
  url: requestUrl(config, '', { 'list-type': 2, prefix: 'captainfin/', 'max-keys': 1 }),
  payloadHash: EMPTY_SHA256,
  now: new Date('2026-08-22T10:00:00.000Z')
});
assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=fixture-access-key\/20260822\/eu-west-2\/s3\/aws4_request,/);
assert(!JSON.stringify(headers).includes('fixture-secret-key-that-must-not-leak'), 'secret access key must never be emitted into request headers');
assert.deepStrictEqual(parseKeys('<ListBucketResult><Contents><Key>captainfin/a.pgdump.enc</Key></Contents><Contents><Key>captainfin/b&amp;c.pgdump.enc</Key></Contents></ListBucketResult>'), [
  'captainfin/a.pgdump.enc',
  'captainfin/b&c.pgdump.enc'
]);
assert.strictEqual(typeof createS3Destination(config).put, 'function');
assert.strictEqual(typeof createS3Destination(config).get, 'function');
assert.strictEqual(typeof createS3Destination(config).list, 'function');
assert.strictEqual(typeof createS3Destination(config).delete, 'function');
assert.strictEqual(typeof createS3Destination(config).health, 'function');

const now = new Date('2026-08-22T10:00:00.000Z');
const worker = { heartbeat_age_seconds: 10, last_error: null };
const policy = { enabled: true, intervalHours: 24 };
const local = {
  id: 'backup-1',
  status: 'succeeded',
  completed_at: '2026-08-22T09:00:00.000Z',
  verified_at: '2026-08-22T09:10:00.000Z',
  checksum_sha256: 'a'.repeat(64),
  metadata: { format: 'pgdump.enc', authenticatedEncryption: true }
};
const noOffsite = deriveRecoveryReadiness({ policy, worker, runs: [local], offsiteEnabled: false, now });
assert.strictEqual(noOffsite.offsite.state, 'off');
assert.strictEqual(noOffsite.overall.kind, 'warn', 'local-only recovery must not be described as fully host-loss ready');

const copied = deriveRecoveryReadiness({
  policy,
  worker,
  runs: [{ ...local, metadata: { ...local.metadata, offsite: { state: 'succeeded', provider: 's3', checksumSha256: 'a'.repeat(64), copiedAt: '2026-08-22T09:11:00.000Z' } } }],
  offsiteEnabled: true,
  now
});
assert.strictEqual(copied.offsite.state, 'copied');
assert.strictEqual(copied.overall.kind, 'good');

const remoteFailed = deriveRecoveryReadiness({
  policy,
  worker,
  runs: [{ ...local, metadata: { ...local.metadata, offsite: { state: 'failed', provider: 's3', error: 'S3 request failed (503)' } } }],
  offsiteEnabled: true,
  now
});
assert.strictEqual(remoteFailed.recovery.kind, 'good', 'remote failure must not invalidate local restore proof');
assert.strictEqual(remoteFailed.offsite.kind, 'bad');
assert.strictEqual(remoteFailed.overall.kind, 'bad');

const backupSource = fs.readFileSync(path.join(root, 'scripts/backup-db.js'), 'utf8');
assert(backupSource.includes("status: 'succeeded'"));
assert(backupSource.includes('await copyOffsite(runId, finalPath, checksum, stat.size)'), 'completed encrypted local backups must flow into off-site copy');
assert(backupSource.indexOf("status: 'succeeded'") < backupSource.indexOf('await copyOffsite(runId, finalPath, checksum, stat.size)'), 'local backup must be finalized before any off-site upload');
assert(backupSource.includes('local encrypted backup remains valid'), 'remote failures must be explicitly separated from local backup validity');

const compose = fs.readFileSync(path.join(root, 'docker-compose.yml'), 'utf8');
const secretOccurrences = (compose.match(/BACKUP_S3_SECRET_ACCESS_KEY:/g) || []).length;
assert.strictEqual(secretOccurrences, 2, 'S3 secret must be available only to backup-worker and explicit recovery-tools');
const appBlock = compose.slice(compose.indexOf('  app:'), compose.indexOf('  automation-worker:'));
assert(appBlock.includes('BACKUP_OFFSITE_ENABLED'));
assert(!appBlock.includes('BACKUP_S3_SECRET_ACCESS_KEY'));
assert(!appBlock.includes('BACKUP_S3_ACCESS_KEY_ID'));
assert(!appBlock.includes('BACKUP_S3_ENDPOINT'));
assert(!appBlock.includes('BACKUP_S3_BUCKET'));

const envExample = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
assert(envExample.includes('BACKUP_OFFSITE_ENABLED=false'));
assert(envExample.includes('BACKUP_S3_ENDPOINT='));
assert(envExample.includes('HTTPS is mandatory'));

const adminSource = fs.readFileSync(path.join(root, 'src/platform/admin-backups.js'), 'utf8');
assert(adminSource.includes('Host-loss copy'));
assert(adminSource.includes('Latest off-host copy'));
assert(adminSource.includes('offsiteBadge'));
assert(!adminSource.includes('BACKUP_S3_SECRET_ACCESS_KEY'), 'normal admin route must never read S3 credentials');
assert(!adminSource.includes('BACKUP_S3_ACCESS_KEY_ID'), 'normal admin route must never read S3 access keys');

const diagnosticsSource = fs.readFileSync(path.join(root, 'src/platform/system-diagnostics.js'), 'utf8');
assert(diagnosticsSource.includes("offsiteState: diagnostics.backups.offsite?.state || 'unknown'"));
assert(diagnosticsSource.includes("'BACKUP_S3_SECRET_ACCESS_KEY'"), 'support sanitizer must recognize the S3 secret');

const docs = fs.readFileSync(path.join(root, 'docs/RECOVERY.md'), 'utf8');
assert(docs.includes('Recover after total host loss'));
assert(docs.includes('node scripts/offsite-backup.js get'));
assert(docs.includes('do not store it in the same S3 bucket'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'captainfin-offsite-'));
const previousBackupDir = process.env.BACKUP_DIR;
try {
  process.env.BACKUP_DIR = tmp;
  const allowed = path.join(tmp, 'captainfin-test.pgdump.enc');
  assert.strictEqual(requireInsideBackups(allowed), allowed);
  assert.throws(() => requireInsideBackups(path.join(tmp, '..', 'escape.pgdump.enc')), /inside BACKUP_DIR/i);
} finally {
  if (previousBackupDir === undefined) delete process.env.BACKUP_DIR;
  else process.env.BACKUP_DIR = previousBackupDir;
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('off-site backup smoke: ok');
