'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const { deriveRecoveryReadiness } = require('../src/platform/backup-recovery-readiness');
const { archiveSummary } = require('./inspect-backup');
const { recoveryPath, shellQuote } = require('../src/platform/admin-backups');

const root = path.join(__dirname, '..');
const now = new Date('2026-08-22T04:00:00.000Z');
const worker = { heartbeat_age_seconds: 20, last_error: null, next_run_at: '2026-08-23T03:00:00.000Z' };
const policy = { enabled: true, intervalHours: 24, retentionDays: 30, minimumCopies: 7, verifyAfterBackup: true };
const verifiedRun = {
  id: 'backup-2',
  status: 'succeeded',
  file_name: 'captainfin-new.pgdump.enc',
  file_path: '/backups/captainfin-new.pgdump.enc',
  completed_at: '2026-08-22T03:00:00.000Z',
  verified_at: '2026-08-22T03:15:00.000Z'
};

const ready = deriveRecoveryReadiness({ policy, worker, runs: [verifiedRun], verificationRequests: [], now });
assert.strictEqual(ready.overall.kind, 'good', 'fresh latest verified backup should be recovery ready');
assert.strictEqual(ready.recovery.state, 'verified');
assert.strictEqual(ready.protection.state, 'healthy');

const olderVerified = { ...verifiedRun, id: 'backup-1', file_name: 'captainfin-old.pgdump.enc', completed_at: '2026-08-21T03:00:00.000Z', verified_at: '2026-08-21T03:10:00.000Z' };
const newestUnverified = { ...verifiedRun, id: 'backup-3', verified_at: null, completed_at: '2026-08-22T03:30:00.000Z' };
const notProven = deriveRecoveryReadiness({ policy, worker, runs: [newestUnverified, olderVerified], verificationRequests: [], now });
assert.strictEqual(notProven.recovery.state, 'unverified', 'older proof must not make newest backup verified');
assert.strictEqual(notProven.overall.kind, 'warn');
assert.strictEqual(notProven.latestVerified.id, 'backup-1');

const queued = deriveRecoveryReadiness({
  policy,
  worker,
  runs: [newestUnverified, olderVerified],
  verificationRequests: [{ backup_run_id: 'backup-3', status: 'queued', requested_at: '2026-08-22T03:40:00.000Z' }],
  now
});
assert.strictEqual(queued.recovery.state, 'queued');
assert.strictEqual(queued.verificationInFlight, true);

const failed = deriveRecoveryReadiness({
  policy,
  worker,
  runs: [newestUnverified],
  verificationRequests: [{ backup_run_id: 'backup-3', status: 'failed', error: 'restore failed' }],
  now
});
assert.strictEqual(failed.recovery.kind, 'bad');
assert.strictEqual(failed.overall.kind, 'bad');

const staleWorker = deriveRecoveryReadiness({ policy, worker: { ...worker, heartbeat_age_seconds: 181 }, runs: [verifiedRun], now });
assert.strictEqual(staleWorker.protection.state, 'stale_worker');
assert.strictEqual(staleWorker.overall.kind, 'bad');

const oldBackup = deriveRecoveryReadiness({
  policy,
  worker,
  runs: [{ ...verifiedRun, completed_at: '2026-08-19T00:00:00.000Z' }],
  now
});
assert.strictEqual(oldBackup.protection.state, 'stale_backup');

const disabled = deriveRecoveryReadiness({ policy: { ...policy, enabled: false }, worker, runs: [verifiedRun], now });
assert.strictEqual(disabled.protection.state, 'off');
assert.strictEqual(disabled.overall.kind, 'warn');

assert.strictEqual(recoveryPath({ file_path: '/backups/predeploy/test.pgdump.enc', file_name: 'test.pgdump.enc' }), 'backups/predeploy/test.pgdump.enc');
assert.strictEqual(shellQuote("a'b"), "'a'\"'\"'b'");

const archive = archiveSummary('1; 0 0 TABLE public schema_migrations owner\n2; 0 0 TABLE public users owner\n3; 0 0 TABLE public plans owner\n4; 0 0 TABLE public servers owner\n5; 0 0 TABLE public settings owner\n');
assert.strictEqual(archive.hasSchemaMigrations, true);
assert.strictEqual(archive.tableCount, 5);

const adminSource = fs.readFileSync(path.join(root, 'src/platform/admin-backups.js'), 'utf8');
assert(adminSource.includes('deriveRecoveryReadiness'), 'admin backups must use the shared readiness model');
assert(adminSource.includes('backup_verification_requests'), 'admin backups must read verification request state');
assert(adminSource.includes('Latest recovery point'), 'admin must distinguish the latest recovery point');
assert(adminSource.includes('Last recovery drill'), 'admin must distinguish historical recovery proof');
assert(adminSource.includes('Host recovery procedure'), 'admin must provide recovery onboarding');
assert(adminSource.includes('bash recovery.sh drill'), 'admin must point to the guarded host recovery helper');
assert(!adminSource.includes("router.post('/admin/backups/restore'"), 'browser must not own a destructive restore endpoint');
assert(!adminSource.includes("require('child_process')"), 'admin route must not gain host command execution');

const recoverySource = fs.readFileSync(path.join(root, 'recovery.sh'), 'utf8');
const shellCheck = spawnSync('bash', ['-n', path.join(root, 'recovery.sh')], { encoding: 'utf8' });
assert.strictEqual(shellCheck.status, 0, `recovery.sh syntax failed: ${shellCheck.stderr}`);
assert(recoverySource.includes('bash recovery.sh check <backup-path>'));
assert(recoverySource.includes('bash recovery.sh drill <backup-path>'));
assert(recoverySource.includes('RESTORE_CONFIRM=RESTORE_CAPTAINFIN_DATABASE'));
assert(recoverySource.includes('backup path must stay inside ./backups'));
assert(recoverySource.includes('backup file may not be a symbolic link'));
assert(recoverySource.includes('recovery-tools node scripts/inspect-backup.js'));
assert(recoverySource.includes('backup-worker node scripts/verify-backup.js'));
assert(recoverySource.includes('docker compose stop app automation-worker activity-worker backup-worker'));
assert(recoverySource.indexOf('inspect_backup\n  wait_postgres') < recoverySource.indexOf("log 'Stopping CAPTAiNFiN application and worker writers'"), 'offline inspection must happen before production writers are stopped');
assert(recoverySource.includes('recovery-tools node scripts/restore-db.js'));
assert(recoverySource.includes('docker compose run --rm --no-deps migrate'));
assert(recoverySource.includes('docker compose exec -T app npm run verify:deployment'));
assert(recoverySource.includes('intentionally left stopped'), 'failed destructive recovery must fail closed');

const inspectSource = fs.readFileSync(path.join(root, 'scripts/inspect-backup.js'), 'utf8');
assert(inspectSource.includes('O_NOFOLLOW'), 'offline backup inspection must refuse symlink traversal');
assert(inspectSource.includes("['--list', plain]"), 'offline inspection must ask pg_restore to parse the archive');
assert(inspectSource.includes('schema_migrations'), 'offline inspection must validate CAPTAiNFiN archive structure');
assert(inspectSource.includes('autoClose: false'), 'inspection must validate and decrypt from the same descriptor');
assert(inspectSource.includes('fs.rmSync(tempDir'), 'temporary plaintext must be cleaned up');

const cssEntry = fs.readFileSync(path.join(root, 'public/css/admin-capability.css'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/css/admin-backup-recovery.css'), 'utf8');
assert(cssEntry.includes("/css/admin-backup-recovery.css"), 'backup recovery styles must load through shared admin CSS');
assert(css.includes('@media(max-width:760px)'), 'recovery workflow must remain mobile-friendly');
assert(css.includes('.recoveryDanger'), 'destructive recovery step needs distinct presentation');

const docs = fs.readFileSync(path.join(root, 'docs/RECOVERY.md'), 'utf8');
assert(docs.includes('Offline recovery-point check'));
assert(docs.includes('Full recovery drill'));
assert(docs.includes('Destructive production restore'));
assert(docs.includes('BACKUP_ENCRYPTION_KEY'));

console.log('backup recovery readiness smoke: ok');
