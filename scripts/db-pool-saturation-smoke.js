'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const db = require('../src/db');

const compose = fs.readFileSync(path.join(__dirname, '..', 'docker-compose.yml'), 'utf8');
assert(compose.includes('DB_POOL_SIZE: ${APP_DB_POOL_SIZE:-20}'), 'web Compose service must default to a 20-connection primary pool');
assert(compose.includes('DB_POOL_MAX_WAITING: ${APP_DB_POOL_MAX_WAITING:-5}'), 'web Compose service must opt into a bounded five-request DB wait queue');
assert(!/automation-worker:[\s\S]*?DB_POOL_MAX_WAITING:/.test(compose), 'automation worker must not inherit the web circuit breaker');
assert(!/activity-worker:[\s\S]*?DB_POOL_MAX_WAITING:/.test(compose), 'activity worker must not inherit the web circuit breaker');
assert(!/backup-worker:[\s\S]*?DB_POOL_MAX_WAITING:/.test(compose), 'backup worker must not inherit the web circuit breaker');

assert.strictEqual(db.poolSize(undefined), 10, 'shared DB helper must retain its historical 10-connection fallback outside explicitly configured services');
assert.strictEqual(db.poolSize('20'), 20, 'web pool size must accept the explicit production value');
assert.strictEqual(db.poolSize('999'), 80, 'pool size must stay bounded');
assert.strictEqual(db.poolMaxWaiting(undefined), null, 'bounded queue protection must be opt-in so workers and tooling keep existing behavior');
assert.strictEqual(db.poolMaxWaiting('0'), 0, 'operators may choose true fail-fast behavior with no queue');
assert.strictEqual(db.poolMaxWaiting('5'), 5, 'web queue limit must be respected');

const unguarded = db.poolStats({
  options: { max: 6 },
  totalCount: 6,
  idleCount: 0,
  waitingCount: 20
}, '');
assert.strictEqual(unguarded.saturated, true, 'pressure should remain observable without a circuit breaker');
assert.strictEqual(unguarded.overloaded, false, 'unconfigured worker pools must not acquire new fail-fast semantics');
assert.strictEqual(unguarded.maxWaiting, null, 'unconfigured worker pool must expose no queue limit');

const healthy = db.poolStats({
  options: { max: 20 },
  totalCount: 20,
  idleCount: 2,
  waitingCount: 0
}, '5');
assert.strictEqual(healthy.saturated, false, 'idle capacity is not saturation');
assert.strictEqual(healthy.overloaded, false, 'idle capacity is not overload');

const saturated = db.poolStats({
  options: { max: 20 },
  totalCount: 20,
  idleCount: 0,
  waitingCount: 1
}, '5');
assert.strictEqual(saturated.saturated, true, 'full pool with a waiter must report saturation');
assert.strictEqual(saturated.overloaded, false, 'a short bounded queue must not trip the circuit breaker immediately');

const overloaded = db.poolStats({
  options: { max: 20 },
  totalCount: 20,
  idleCount: 0,
  waitingCount: 5
}, '5');
assert.strictEqual(overloaded.overloaded, true, 'queue at the configured limit must trip the circuit breaker');

const zeroQueueFull = db.poolStats({
  options: { max: 20 },
  totalCount: 20,
  idleCount: 0,
  waitingCount: 0
}, '0');
assert.strictEqual(zeroQueueFull.overloaded, true, 'zero-queue mode must reject before the first request is queued');

const error = db.poolOverloadError('smoke', overloaded);
assert.strictEqual(error.status, 503, 'overload must be surfaced as HTTP 503');
assert.strictEqual(error.code, 'DB_POOL_SATURATED', 'overload must have a stable machine-readable code');

console.log('db-pool-saturation-smoke: ok');
