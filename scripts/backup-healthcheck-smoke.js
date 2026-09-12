'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rowHealthy } = require('./backup-healthcheck');
const { dueFromRow } = require('./backup-worker');

assert.strictEqual(rowHealthy(null), false, 'missing worker state must be unhealthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: null, next_run_at: new Date() }), true, 'fresh worker without errors must be healthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: 'permission denied', next_run_at: new Date() }), true, 'a live worker with an operation error must remain container-healthy while recovery health reports the failure');
assert.strictEqual(rowHealthy({ age: 20, last_error: 'old failure', next_run_at: null }), true, 'disabled backup policy may retain historical error text without making the worker process unhealthy');
assert.strictEqual(rowHealthy({ age: 181, last_error: null, next_run_at: new Date() }), false, 'stale worker heartbeat must be unhealthy');

const cfg = { intervalHours: 24 };
const now = new Date('2026-09-12T08:00:00.000Z');
assert.strictEqual(
  dueFromRow(cfg, { last_error: 'restore failed', next_run_at: '2026-09-12T09:00:00.000Z', last_success_at: null }, now),
  false,
  'a failed backup must honor its future retry time instead of retrying every worker poll'
);
assert.strictEqual(
  dueFromRow(cfg, { last_error: 'restore failed', next_run_at: '2026-09-12T07:59:59.000Z', last_success_at: null }, now),
  true,
  'a failed backup becomes due after its scheduled retry time'
);
assert.strictEqual(
  dueFromRow(cfg, { last_error: 'legacy failure', next_run_at: null, last_success_at: null }, now),
  true,
  'legacy failed state without a retry timestamp remains recoverable'
);
assert.strictEqual(
  dueFromRow(cfg, { last_error: null, next_run_at: '2026-09-13T08:00:00.000Z', last_success_at: '2026-09-12T08:00:00.000Z' }, now),
  false,
  'normal scheduled backups must also honor next_run_at'
);

const workerSource = fs.readFileSync(path.join(__dirname, 'backup-worker.js'), 'utf8');
assert(workerSource.indexOf('if (row.next_run_at)') < workerSource.indexOf('if (row.last_error)'), 'persisted retry schedule must be checked before persisted error state');

const backupSource = fs.readFileSync(path.join(__dirname, 'backup-db.js'), 'utf8');
assert(
  backupSource.includes('--exclude-table-data=public.active_playback_sessions'),
  'database backups must exclude ephemeral active playback rows so stale sessions cannot invalidate restore verification'
);

const verifySource = fs.readFileSync(path.join(__dirname, 'verify-backup.js'), 'utf8');
assert(verifySource.includes('cleanupStaleVerificationDatabases'), 'verification must clean abandoned temporary verification databases');
assert(verifySource.includes("/^captainfin_verify_[0-9a-f]{12}$/"), 'stale verification cleanup must be restricted to generated verification database names');
assert(verifySource.includes('NOT EXISTS ('), 'stale verification cleanup must avoid databases with active sessions');

console.log('backup healthcheck smoke: ok');
