'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const runtimeSource = fs.readFileSync(path.join(root, 'src/stremio/runtime.js'), 'utf8');
const limiterSource = fs.readFileSync(path.join(root, 'src/security/route-rate-limit.js'), 'utf8');

assert.strictEqual((runtimeSource.match(/backend: 'memory'/g) || []).length, 3, 'all Stremio protocol rate limits must avoid the shared database request path');
assert(limiterSource.includes("backend = 'database'"), 'shared database rate limiting must remain the default for sensitive routes');
assert(limiterSource.includes("if (storage === 'memory')"), 'route limiter must support an explicit bounded in-memory backend');

const dbPath = require.resolve('../src/db');
const limiterPath = require.resolve('../src/security/route-rate-limit');
const originalDbCache = require.cache[dbPath];
const originalLimiterCache = require.cache[limiterPath];
let databaseCalls = 0;

require.cache[dbPath] = {
  id: dbPath,
  filename: dbPath,
  loaded: true,
  exports: {
    query: async () => {
      databaseCalls += 1;
      throw new Error('synthetic database connection timeout');
    }
  }
};
delete require.cache[limiterPath];
const limiter = require(limiterPath);

function response() {
  return {
    headers: {},
    statusCode: 200,
    body: null,
    setHeader(name, value) { this.headers[name] = String(value); },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; }
  };
}

(async () => {
  limiter.clearMemoryBuckets();
  const memoryLimit = limiter.middleware({
    scope: 'stremio-stream-test',
    max: 2,
    windowSeconds: 60,
    identity: () => 'same-install',
    reason: 'protocol_rate_limit',
    backend: 'memory'
  });

  let nextCalls = 0;
  await memoryLimit({}, response(), () => { nextCalls += 1; });
  await memoryLimit({}, response(), () => { nextCalls += 1; });
  assert.strictEqual(nextCalls, 2, 'allowed Stremio protocol requests must continue immediately');
  assert.strictEqual(databaseCalls, 0, 'Stremio memory-backed limiter must not touch PostgreSQL');

  const limited = response();
  await memoryLimit({}, limited, () => { nextCalls += 1; });
  assert.strictEqual(limited.statusCode, 429, 'memory-backed limiter must still enforce the configured protocol limit');
  assert.strictEqual(limited.headers['X-CAPTAiNFiN-429-Reason'], 'protocol_rate_limit');
  assert.strictEqual(nextCalls, 2, 'limited requests must not reach the route');
  assert.strictEqual(databaseCalls, 0, 'protocol limiting must remain independent of PostgreSQL even when rejecting');

  const databaseLimit = limiter.middleware({ scope: 'sensitive-test', max: 2, windowSeconds: 60 });
  const failedClosed = response();
  const originalError = console.error;
  console.error = () => {};
  try {
    await databaseLimit({}, failedClosed, () => { nextCalls += 1; });
  } finally {
    console.error = originalError;
  }
  assert.strictEqual(databaseCalls, 1, 'default rate limiting must still use the shared database');
  assert.strictEqual(failedClosed.statusCode, 503, 'sensitive/default database-backed limits must still fail closed on store failure');
  assert.strictEqual(nextCalls, 2, 'database-backed store failure must not bypass sensitive limits');

  limiter.clearMemoryBuckets();
  console.log('stremio rate limit smoke: ok');
})().finally(() => {
  if (originalDbCache) require.cache[dbPath] = originalDbCache;
  else delete require.cache[dbPath];
  if (originalLimiterCache) require.cache[limiterPath] = originalLimiterCache;
  else delete require.cache[limiterPath];
}).catch(error => {
  console.error(error);
  process.exitCode = 1;
});
