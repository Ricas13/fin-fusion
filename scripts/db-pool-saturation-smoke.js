'use strict';

const assert = require('assert');
const db = require('../src/db');

assert.strictEqual(db.poolSize(undefined), 20, 'web/default pool should have 20 connections of headroom');
assert.strictEqual(db.poolSize('10'), 10, 'explicit worker pool sizes must remain respected');
assert.strictEqual(db.poolSize('999'), 80, 'pool size must stay bounded');
assert.strictEqual(db.poolMaxWaiting(undefined, 20), 5, 'default queue limit should be 25% of pool size');
assert.strictEqual(db.poolMaxWaiting('0', 20), 0, 'operators may choose fail-fast with no queue');
assert.strictEqual(db.poolMaxWaiting('7', 20), 7, 'explicit queue limit must be respected');

const healthy = db.poolStats({
  options: { max: 20 },
  totalCount: 20,
  idleCount: 2,
  waitingCount: 0
}, undefined);
assert.strictEqual(healthy.saturated, false, 'idle capacity is not saturation');
assert.strictEqual(healthy.overloaded, false, 'idle capacity is not overload');

const saturated = db.poolStats({
  options: { max: 20 },
  totalCount: 20,
  idleCount: 0,
  waitingCount: 1
}, undefined);
assert.strictEqual(saturated.saturated, true, 'full pool with a waiter must report saturation');
assert.strictEqual(saturated.overloaded, false, 'a short bounded queue must not trip the circuit breaker immediately');

const overloaded = db.poolStats({
  options: { max: 20 },
  totalCount: 20,
  idleCount: 0,
  waitingCount: 5
}, undefined);
assert.strictEqual(overloaded.overloaded, true, 'queue at the configured limit must trip the circuit breaker');

const error = db.poolOverloadError('smoke', overloaded);
assert.strictEqual(error.status, 503, 'overload must be surfaced as HTTP 503');
assert.strictEqual(error.code, 'DB_POOL_SATURATED', 'overload must have a stable machine-readable code');

console.log('db-pool-saturation-smoke: ok');
