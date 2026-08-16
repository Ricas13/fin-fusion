'use strict';

const assert = require('assert');
const { rowHealthy } = require('./backup-healthcheck');

assert.strictEqual(rowHealthy(null), false, 'missing worker state must be unhealthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: null, next_run_at: new Date() }), true, 'fresh worker without errors must be healthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: 'permission denied', next_run_at: new Date() }), false, 'fresh heartbeat with an active failed backup must be unhealthy');
assert.strictEqual(rowHealthy({ age: 20, last_error: 'old failure', next_run_at: null }), true, 'disabled backup policy may retain historical error text without being operationally unhealthy');
assert.strictEqual(rowHealthy({ age: 181, last_error: null, next_run_at: new Date() }), false, 'stale worker heartbeat must be unhealthy');

console.log('backup healthcheck smoke: ok');
