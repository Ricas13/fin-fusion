'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { rowHealthy } = require('./backup-healthcheck');

assert.strictEqual(rowHealthy(null), false, 'missing worker state must be unhealthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: null, next_run_at: new Date() }), true, 'fresh worker without errors must be healthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: 'permission denied', next_run_at: new Date() }), false, 'fresh heartbeat with an active failed backup must be unhealthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: 'old failure', next_run_at: null }), true, 'disabled backup policy may retain historical error text without being operationally unhealthy');
assert.strictEqual(rowHealthy({ age: 181, last_error: null, next_run_at: new Date() }), false, 'stale worker heartbeat must be unhealthy');

const workerSource = fs.readFileSync(path.join(__dirname, 'backup-worker.js'), 'utf8');
assert(workerSource.includes('SELECT last_success_at,next_run_at,last_error FROM backup_worker_state'), 'worker due check must read persisted error state');
assert(workerSource.includes('if(row.last_error)return true;'), 'persisted backup errors must trigger an immediate retry after restart');

console.log('backup healthcheck smoke: ok');
