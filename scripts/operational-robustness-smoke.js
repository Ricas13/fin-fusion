'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const requestSync = require('../src/integrations/request-user-sync');
const workerHealth = require('../src/platform/worker-instance-health');
const providerHttp = require('../src/payments/provider-http');
const billingControl = require('../src/payments/billing-control');
const stripe = require('../src/payments/stripe');
const application = require('../src/application');
const subscriptionExpiry = require('../src/entitlements/subscription-expiry');

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

async function testDeletionBillingControl() {
  const row = { id: 'sub-local', source: 'stripe', provider_subscription_id: 'sub_remote', customer_id: 'customer-1' };
  let seen = null;
  const result = await billingControl.terminateRecurringForDeletion(row, {
    idempotencyKey: 'delete-target-1',
    adapter: {
      terminate: async (received, options) => {
        seen = { received, options };
        return { status: 'cancelled', remoteStatus: 'canceled' };
      }
    }
  });
  assert.strictEqual(result.status, 'cancelled');
  assert.strictEqual(result.providerSubscriptionId, 'sub_remote');
  assert.strictEqual(seen.received, row, 'deletion cancellation must use the existing billing-control adapter contract');
  assert.strictEqual(seen.options.idempotencyKey, 'delete-target-1');
  await assert.rejects(
    billingControl.terminateRecurringForDeletion(row, { adapter: { terminate: async () => { throw new Error('provider unavailable'); } } }),
    /provider unavailable/,
    'provider cancellation failure must propagate so deletion stays blocked'
  );

  const source = fs.readFileSync(path.join(__dirname, '../src/payments/billing-control.js'), 'utf8');
  assert.match(source, /subscriptions\.cancel\([\s\S]+invoice_now:\s*false[\s\S]+prorate:\s*false/, 'Stripe hard deletion must immediately cancel without creating an extra proration invoice');
  assert.match(source, /billing\/subscriptions\/[\s\S]+\/cancel/, 'PayPal hard deletion must use the subscription cancellation endpoint');
  assert.match(source, /paypalTerminalStatus\(remoteStatus\)/, 'PayPal cancellation must be verified from the remote terminal state');
}

function testProviderOwnedExpirySafety() {
  const stripeRow = { source: 'stripe', provider_subscription_id: 'sub_expiry' };
  const paypalRow = { source: 'paypal', provider_subscription_id: 'I-EXPIRY' };
  assert.strictEqual(subscriptionExpiry.providerExpiryProtected(stripeRow, { ok: false }), true, 'failed provider verification must preserve local access');
  assert.strictEqual(subscriptionExpiry.providerExpiryProtected(stripeRow, { ok: true, remote: { status: 'active', cancelAtPeriodEnd: false } }), true, 'healthy auto-renewing Stripe access must not be locally expired');
  assert.strictEqual(subscriptionExpiry.providerExpiryProtected(paypalRow, { ok: true, remote: { status: 'ACTIVE', cancelAtPeriodEnd: false } }), true, 'healthy auto-renewing PayPal access must not be locally expired');
  assert.strictEqual(subscriptionExpiry.providerExpiryProtected(stripeRow, { ok: true, remote: { status: 'active', cancelAtPeriodEnd: true } }), false, 'verified end-of-term cancellation may expire locally when due');
  assert.strictEqual(subscriptionExpiry.providerExpiryProtected(stripeRow, { ok: true, remote: { status: 'past_due', cancelAtPeriodEnd: false } }), false, 'delinquent provider state must retain the existing local expiry/grace policy');
  const source = fs.readFileSync(path.join(__dirname, '../src/entitlements/subscription-expiry.js'), 'utf8');
  assert.match(source, /dueRecurringSubscriptions\(\)/, 'expiry must identify provider-owned due subscriptions before the destructive update');
  assert.match(source, /billing-control'\)\.syncSubscription/, 'normal expiry execution must refresh current provider truth through canonical billing control');
  assert.match(source, /NOT \(s\.id=ANY\(\$1::uuid\[\]\)\)/, 'provider subscriptions that cannot be safely expired must be excluded from the destructive update');
}

function testStripeWebhookOrdering() {
  assert.strictEqual(stripe.effectiveSyncStatus('active', 'past_due'), 'active', 'late failed invoice must not regress a recovered active subscription');
  assert.strictEqual(stripe.effectiveSyncStatus('trialing', 'past_due'), 'trialing', 'late failed invoice must not regress a recovered trial');
  assert.strictEqual(stripe.effectiveSyncStatus('past_due', 'past_due'), 'past_due');
  assert.strictEqual(stripe.effectiveSyncStatus('canceled', 'active'), 'canceled', 'terminal provider state remains authoritative');
  const source = fs.readFileSync(path.join(__dirname, '../src/payments/stripe.js'), 'utf8');
  assert.match(source, /invoice\.payment_failed[\s\S]+\['active','trialing'\]\.includes\(synced\.effectiveStatus\)[\s\S]+historical only/, 'late failed-invoice handler must resolve historical failures instead of recording a new incident');
}

async function testGracefulShutdown() {
  let closeCalled = 0;
  let idleClosed = 0;
  let dbClosed = 0;
  let exitCode = null;
  let intervalCleared = 0;
  const fakeServer = {
    close(callback) { closeCalled += 1; setImmediate(() => callback()); },
    closeIdleConnections() { idleClosed += 1; },
    closeAllConnections() { throw new Error('should not force-close a healthy drain'); }
  };
  const shutdown = application.createGracefulShutdown({
    server: fakeServer,
    prune: { fake: true },
    closeDatabase: async () => { dbClosed += 1; },
    exit: code => { exitCode = code; },
    timeoutMs: 1000,
    clearIntervalFn: () => { intervalCleared += 1; }
  });
  const first = shutdown('SIGTERM');
  const second = shutdown('SIGINT');
  assert.strictEqual(first, second, 'shutdown must be idempotent across duplicate process signals');
  const code = await first;
  assert.strictEqual(code, 0);
  assert.strictEqual(closeCalled, 1, 'HTTP listener must stop accepting new connections once');
  assert.strictEqual(idleClosed, 1, 'idle keep-alive sockets may be closed without killing in-flight work');
  assert.strictEqual(dbClosed, 1, 'database pool must close after HTTP drain');
  assert.strictEqual(intervalCleared, 1, 'background web-process cleanup interval must stop during drain');
  assert.strictEqual(exitCode, 0);
  assert.strictEqual(application.shutdownGraceMs(1), 1000);
  assert.strictEqual(application.shutdownGraceMs(999999), 120000);
  const source = fs.readFileSync(path.join(__dirname, '../src/application.js'), 'utf8');
  assert.match(source, /process\.once\('SIGTERM'/, 'production web process must own SIGTERM');
  assert.match(source, /closeAllConnections/, 'bounded shutdown must have a forced-close escape hatch');
}

(async () => {
  testRequestDiff();
  await testBoundedConcurrency();
  testWorkerInstances();
  await testProviderDeadlines();
  await testDeletionBillingControl();
  testProviderOwnedExpirySafety();
  testStripeWebhookOrdering();
  await testGracefulShutdown();
  console.log('operational robustness smoke: ok');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
