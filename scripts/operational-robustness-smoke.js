'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const requestSync = require('../src/integrations/request-user-sync');
const workerHealth = require('../src/platform/worker-instance-health');
const providerHttp = require('../src/payments/provider-http');

async function testBoundedConcurrency() {
  let active = 0;
  let peak = 0;
  const values = await requestSync.mapBounded(Array.from({ length: 12 }, (_, index) => index), 3, async value => {
    active++;
    peak = Math.max(peak, active);
    await new Promise(resolve => setTimeout(resolve, 8));
    active--;
    return value * 2;
  });
  assert.strictEqual(peak, 3, 'request sync must respect its bounded mutation pool');
  assert.deepStrictEqual(values, Array.from({ length: 12 }, (_, index) => index * 2));
  assert.strictEqual(requestSync.syncConcurrency('999'), 8, 'configured request concurrency must remain capped');
}

function testRequestDiff() {
  const desired = {
    username: 'same-user', email: 'same@example.test', locale: 'en', discoverRegion: null,
    streamingRegion: null, region: null, originalLanguage: null, watchlistSyncMovies: false,
    watchlistSyncTv: false, movieQuotaLimit: 2, movieQuotaDays: 30, tvQuotaLimit: 2, tvQuotaDays: 30
  };
  assert.strictEqual(requestSync.mainSettingsChanged({ ...desired }, desired), false, 'unchanged remote request settings must not be considered writable');
  assert.strictEqual(requestSync.mainSettingsChanged({ ...desired, movieQuotaLimit: 1 }, desired), true);
  const source = fs.readFileSync(path.join(__dirname, '../src/integrations/request-user-sync.js'), 'utf8');
  assert.match(source, /if \(changed\) await apiRequest\([^\n]+method: 'POST'/, 'main settings POST must be guarded by the diff result');
  assert.match(source, /mapBounded\(candidates/, 'customer mutations must use bounded concurrency');
  assert.match(source, /catch \(error\) \{ return \{ status: 'failed'/, 'one customer failure must settle independently');
}

function testWorkerInstances() {
  const rows = [
    { worker_key: 'activity', instance_id: 'activity-a', version: '1.4.0', commit_sha: 'aaa', heartbeat_age_seconds: 10, metadata: { pollSeconds: 20 } },
    { worker_key: 'activity', instance_id: 'activity-b', version: '1.4.1', commit_sha: 'bbb', heartbeat_age_seconds: 20, metadata: { pollSeconds: 20 } },
    { worker_key: 'automation', instance_id: 'automation-old', version: '1.4.0', commit_sha: 'aaa', heartbeat_age_seconds: 5000, metadata: { pollMs: 15000 } }
  ];
  const summary = workerHealth.summarize(rows);
  assert.strictEqual(summary.instances.length, 3, 'duplicate worker instances must remain separately visible');
  const activity = summary.workers.find(worker => worker.key === 'activity');
  assert.strictEqual(activity.liveInstances, 2);
  assert(summary.warnings.some(warning => warning.type === 'duplicate_instances' && warning.workerKey === 'activity'));
  assert(summary.warnings.some(warning => warning.type === 'version_skew'), 'commit/version skew must surface as an operational warning');
  assert(summary.warnings.some(warning => warning.type === 'stale_instance' && warning.instanceId === 'automation-old'));

  const migration = fs.readFileSync(path.join(__dirname, '../db/migrations/20260829174000_worker_instance_health.sql'), 'utf8');
  assert.match(migration, /PRIMARY KEY\(worker_key, instance_id\)/i);
  assert.match(migration, /DELETE FROM public\.operational_worker_state[\s\S]+last_heartbeat_at < NOW\(\)/i, 'stale instance records must have durable expiry cleanup');
  assert.match(migration, /interval '24 hours'/i);
  assert.match(migration, /ON CONFLICT\(worker_key,instance_id\)/i);
}

async function testProviderDeadlines() {
  const hangingFetch = (_url, options = {}) => new Promise((_resolve, reject) => {
    options.signal.addEventListener('abort', () => {
      const error = new Error('aborted');
      error.name = 'AbortError';
      reject(error);
    }, { once: true });
  });
  const started = Date.now();
  await assert.rejects(
    providerHttp.fetchJson('paypal', 'https://api-m.paypal.com/test', {}, { timeout: 20, fetchImpl: hangingFetch }),
    error => error?.code === 'timeout' && error?.retryable === true && error?.provider === 'paypal'
  );
  assert(Date.now() - started < 1000, 'hanging provider request must terminate near the configured deadline');

  const successful = await providerHttp.fetchJson('paypal', 'https://api-m.paypal.com/test', {}, {
    timeout: 1000,
    fetchImpl: async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'paypal-debug-id': 'debug-123' } })
  });
  assert.deepStrictEqual(successful.data, { ok: true }, 'successful provider response behavior must remain unchanged');
  assert.strictEqual(successful.requestId, 'debug-123');
  assert.strictEqual(providerHttp.retryableStatus(429), true);
  assert.strictEqual(providerHttp.retryableStatus(503), true);
  assert.strictEqual(providerHttp.retryableStatus(400), false);
  assert.strictEqual(providerHttp.classifySdkError('stripe', { type: 'StripeConnectionError', requestId: 'req_123' }).retryable, true);

  const paypalSource = fs.readFileSync(path.join(__dirname, '../src/payments/paypal.js'), 'utf8');
  const stripeSource = fs.readFileSync(path.join(__dirname, '../src/payments/stripe.js'), 'utf8');
  const billingControlSource = fs.readFileSync(path.join(__dirname, '../src/payments/billing-control.js'), 'utf8');
  const providerRecoverySource = fs.readFileSync(path.join(__dirname, '../src/payments/provider-operation-recovery.js'), 'utf8');
  const plisioSource = fs.readFileSync(path.join(__dirname, '../src/payments/plisio.js'), 'utf8');
  assert.match(paypalSource, /providerHttp\.fetchJson\('paypal'/, 'PayPal native HTTP must use the deadline transport');
  assert.doesNotMatch(paypalSource, /await fetch\(/, 'PayPal must not retain unbounded native fetch calls');
  assert.match(stripeSource, /timeout: providerHttp\.timeoutMs\('stripe'\)/, 'Stripe SDK client must have an application timeout');
  assert.match(billingControlSource, /providerHttp\.fetchJson\('paypal'/, 'Billing-control PayPal HTTP must use the deadline transport');
  assert.doesNotMatch(billingControlSource, /await fetch\(/, 'Billing-control must not retain unbounded PayPal fetch calls');
  assert.match(billingControlSource, /timeout:\s*providerHttp\.timeoutMs\('stripe'\)/, 'Billing-control Stripe SDK client must have an application timeout');
  assert.match(providerRecoverySource, /timeout:\s*providerHttp\.timeoutMs\('stripe'\)/, 'Provider-operation recovery Stripe SDK client must have an application timeout');
  assert.match(plisioSource, /AbortController/, 'Plisio existing application deadline must remain intact');
  assert.match(plisioSource, /15000/, 'Plisio existing 15s deadline must remain intact');
}

(async () => {
  testRequestDiff();
  await testBoundedConcurrency();
  testWorkerInstances();
  await testProviderDeadlines();
  console.log('operational robustness smoke: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
