'use strict';

// Behavioural regressions for defects found by the deep static audit. These run
// without a database: db.query and the provider/command owners are stubbed so
// the real route/handler code paths still execute.

process.env.DATABASE_URL ||= 'postgres://audit:audit@127.0.0.1:1/audit';
process.env.DATA_ENCRYPTION_KEY ||= '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.JELLYFIN_ENCRYPTION_KEY ||= '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
process.env.NODE_ENV ||= 'test';

const assert = require('assert');

function makeRes() {
  return {
    redirected: null,
    statusCode: 200,
    body: null,
    redirect(url) { this.redirected = url; return this; },
    status(code) { this.statusCode = code; return this; },
    send(body) { this.body = body; return this; },
    setHeader() { return this; }
  };
}

function findPostHandler(router, routePath) {
  const layer = router.stack.find(item => item.route && item.route.path === routePath && item.route.methods.post);
  assert(layer, `POST ${routePath} route must exist`);
  const handlers = layer.route.stack;
  return handlers[handlers.length - 1].handle;
}

async function planLibrariesSaveReachesCommandOwner() {
  // Regression: admin-plan-libraries.js called planCommands.updateLibraries without
  // importing planCommands, so every library-access save died with a swallowed
  // ReferenceError and redirected to a generic "could not be saved" error.
  const db = require('../src/db');
  const originalQuery = db.query;
  db.query = async sql => {
    const text = String(sql);
    if (/FROM plans WHERE id=\$1/.test(text)) return { rows: [{ id: 'plan-1', code: 'plan-a', service_type: 'jellyfin', server_class: 'premium' }], rowCount: 1 };
    if (/COUNT\(DISTINCT customer_id\)/.test(text)) return { rows: [{ n: 0 }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  const csrf = require('../src/auth/csrf');
  const originalVerify = csrf.verify;
  csrf.verify = () => true;
  const planServers = require('../src/jellyfin/plan-servers');
  const originalServers = planServers.eligibleServersForPlan;
  planServers.eligibleServersForPlan = async () => [];
  const planCommands = require('../src/catalog/plan-command-service');
  const originalUpdate = planCommands.updateLibraries;
  const calls = [];
  planCommands.updateLibraries = async args => { calls.push(args); return { ok: true }; };
  const bulkJobs = require('../src/platform/bulk-jobs');
  const originalQueue = bulkJobs.queuePlanReconciliation;
  bulkJobs.queuePlanReconciliation = async () => null;
  try {
    const { createAdminPlanLibrariesRouter } = require('../src/platform/admin-plan-libraries');
    const handler = findPostHandler(createAdminPlanLibrariesRouter(), '/admin/plans/:id/libraries');
    const res = makeRes();
    await handler({ params: { id: 'plan-1' }, body: { libraryAccessMode: 'all' }, session: { authUserId: 'admin-1' }, query: {} }, res);
    assert.strictEqual(calls.length, 1, 'saving library access must reach planCommands.updateLibraries');
    assert.strictEqual(calls[0].planId, 'plan-1');
    assert.strictEqual(calls[0].mode, 'all');
    assert.strictEqual(calls[0].actorUserId, 'admin-1');
    assert(res.redirected && !/[?&]error=/.test(res.redirected), `library save must not redirect to an error (got ${res.redirected})`);
  } finally {
    db.query = originalQuery;
    csrf.verify = originalVerify;
    planServers.eligibleServersForPlan = originalServers;
    planCommands.updateLibraries = originalUpdate;
    bulkJobs.queuePlanReconciliation = originalQueue;
  }
}

async function bulkPaymentsSyncUsesCanonicalBillingControl() {
  // Regression: the bulk payments_sync handler called stripe.syncSubscription and
  // paypal.getSubscription, neither of which exists, so every sync failed.
  const bulkWorker = require('../src/jellyfin/bulk-worker');
  const captured = {};
  const originalRegister = bulkWorker.registerHandler;
  bulkWorker.registerHandler = (type, fn) => { captured[type] = fn; };
  const db = require('../src/db');
  const originalQuery = db.query;
  const auditRows = [];
  db.query = async (sql, params) => {
    const text = String(sql);
    if (/FROM subscriptions WHERE customer_id=\$1/.test(text)) {
      assert.deepStrictEqual(params, ['cust-1']);
      return { rows: [
        { id: 'sub-ok', source: 'stripe', provider_subscription_id: 'sub_ok' },
        { id: 'sub-bad', source: 'paypal', provider_subscription_id: 'I-BAD' },
        { id: 'sub-skip', source: 'stripe', provider_subscription_id: 'sub_skip' }
      ], rowCount: 3 };
    }
    if (/INSERT INTO audit_log/.test(text)) { auditRows.push(params); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  };
  const billingControl = require('../src/payments/billing-control');
  const originalSync = billingControl.syncSubscription;
  const originalIsRecurring = billingControl.isRecurring;
  const synced = [];
  billingControl.isRecurring = row => row.id !== 'sub-skip';
  billingControl.syncSubscription = async id => {
    synced.push(id);
    return id === 'sub-bad' ? { ok: false, error: 'provider said no' } : { ok: true };
  };
  try {
    delete require.cache[require.resolve('../src/customers/bulk-operations')];
    require('../src/customers/bulk-operations');
    const handler = captured.payments_sync;
    assert.strictEqual(typeof handler, 'function', 'payments_sync handler must be registered');
    await assert.rejects(handler({ customer_id: 'cust-1' }), /1 payment sync\(s\) failed: paypal: provider said no/);
    assert.deepStrictEqual(synced, ['sub-ok', 'sub-bad'], 'only recurring subscriptions are synced, by internal subscription id');
    const audit = JSON.parse(auditRows[0][2]);
    assert.deepStrictEqual({ synced: audit.synced, failed: audit.failed }, { synced: 1, failed: 1 });
    synced.length = 0;
    billingControl.syncSubscription = async id => { synced.push(id); return { ok: true }; };
    const result = await handler({ customer_id: 'cust-1' });
    assert.deepStrictEqual(result, { synced: 2 });
  } finally {
    bulkWorker.registerHandler = originalRegister;
    db.query = originalQuery;
    billingControl.syncSubscription = originalSync;
    billingControl.isRecurring = originalIsRecurring;
    delete require.cache[require.resolve('../src/customers/bulk-operations')];
  }
}

async function asyncHandlerRejectionsReachErrorMiddleware() {
  // Regression: Express 4 ignores promises returned by async handlers, so ~35
  // handlers with awaits outside try/catch (session destroy, token lookups,
  // audit writes in catch blocks...) could hang the request and crash the whole
  // process on an unhandled rejection whenever the database hiccuped.
  const fs = require('fs');
  const path = require('path');
  const application = fs.readFileSync(path.join(__dirname, '..', 'src', 'application.js'), 'utf8');
  assert(/require\('\.\/platform\/async-route-errors'\)\.install\(\)/.test(application), 'application.js must install async route error forwarding');

  const express = require('express');
  const asyncRouteErrors = require('../src/platform/async-route-errors');
  const unhandled = [];
  const onUnhandled = reason => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  asyncRouteErrors.install();
  const app = express();
  app.get('/ok', async (_req, res) => { await Promise.resolve(); res.send('fine'); });
  app.get('/boom-async', async () => { await Promise.resolve(); throw new Error('async boom'); });
  app.get('/boom-sync', () => { throw new Error('sync boom'); });
  app.get('/boom-catch', async () => {
    try { throw new Error('inner'); } catch (_error) { await Promise.reject(new Error('catch-block boom')); }
  });
  app.use(async (error, _req, res, _next) => { res.status(500).send(`handled: ${error.message}`); });
  const server = await new Promise(resolve => { const listening = app.listen(0, '127.0.0.1', () => resolve(listening)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = async route => {
      const response = await fetch(base + route, { signal: AbortSignal.timeout(3000) });
      return { status: response.status, body: await response.text() };
    };
    assert.deepStrictEqual(await get('/ok'), { status: 200, body: 'fine' });
    assert.deepStrictEqual(await get('/boom-async'), { status: 500, body: 'handled: async boom' });
    assert.deepStrictEqual(await get('/boom-sync'), { status: 500, body: 'handled: sync boom' });
    assert.deepStrictEqual(await get('/boom-catch'), { status: 500, body: 'handled: catch-block boom' });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepStrictEqual(unhandled, [], 'no handler rejection may escape as an unhandled rejection');
    assert.strictEqual(asyncRouteErrors.install(), false, 'installing twice must be a no-op');
  } finally {
    process.removeListener('unhandledRejection', onUnhandled);
    server.closeAllConnections?.();
    server.close();
  }
}

async function pathGuardsIgnoreCaseAndTrailingSlash() {
  // Regression: Express routes case-insensitively, but the owner boundary, step-up,
  // CSRF, rate-limit, Turnstile and impersonation guards compared req.path exactly.
  const { canonicalPath } = require('../src/platform/canonical-path');
  assert.strictEqual(canonicalPath('/Admin//Settings/X/?a=1'), '/admin/settings/x');
  assert.strictEqual(canonicalPath('/'), '/');
  const { isOwnerOnlyPath } = require('../src/auth/owner-guard');
  for (const p of ['/Settings/platform', '/BACKUPS/run', '/Payments/', '/Provider-Mappings/x', '//settings/x', '/security/2fa-policy', '/Security/2FA-Policy/']) {
    assert(isOwnerOnlyPath(p), `${p} must be owner-only`);
  }
  assert(!isOwnerOnlyPath('/users/1'), '/users stays available to support admins');
  const stepUp = require('../src/auth/admin-step-up');
  for (const p of ['/Admin/Plans/1/edit', '/admin/PAYMENTS/x', '/admin/backups/Restore']) {
    assert(stepUp.sensitive({ method: 'POST', path: p }), `${p} must require step-up`);
  }
  const abuse = require('../src/security/public-abuse-protection');
  const cfg = { enabled: true, protectPasswordReset: true };
  for (const p of ['/login/', '/LOGIN', '/Account/Login/', '/account/Register', '/account/forgot-password/']) {
    assert(abuse.shouldProtect(cfg, p), `${p} must be Turnstile-protected`);
  }
  const imp = require('../src/platform/admin-impersonation');
  if (imp.restrictedImpersonationAction) {
    const blocked = imp.restrictedImpersonationAction({ session: { impersonation: {} }, method: 'POST', path: '/ACCOUNT/checkout/' });
    assert(blocked, 'impersonation spend guard must apply to /ACCOUNT/checkout/');
  }
}

async function customerTwoFactorFailureCounterResetsAfterLockExpiry() {
  const db = require('../src/db');
  const original = db.transaction;
  const updates = [];
  db.transaction = async fn => fn({ query: async (sql, params) => {
    const text = String(sql);
    if (/FOR UPDATE/.test(text)) return { rowCount: 1, rows: [{ failed_login_count: 5, locked_until: new Date(Date.now() - 60000) }] };
    if (/UPDATE app_users/.test(text)) { updates.push(params); return { rows: [{ locked_until: null }], rowCount: 1 }; }
    return { rows: [], rowCount: 1 };
  } });
  try {
    delete require.cache[require.resolve('../src/security/customer-two-factor')];
    const result = await require('../src/security/customer-two-factor').recordFailure('u1');
    assert.strictEqual(result.failures, 1, 'expired lock must restart the failure count');
    assert.strictEqual(result.locked, false);
  } finally {
    db.transaction = original;
    delete require.cache[require.resolve('../src/security/customer-two-factor')];
  }
}

async function noRequireCycleHandsOutPartialExports() {
  // Regression: affiliate-credits -> plan-pricing -> reporting-currency -> plan-command-service
  // -> plan-pricing handed plan-command-service an empty plan-pricing export, so saving plan
  // pricing or cloning crashed with "planPricing.resolvePrice is not a function".
  const { spawnSync } = require('child_process');
  const script = `
    const Module = require('module');
    const load = Module._load;
    const loading = new Set();
    const bad = [];
    Module._load = function (request, parent, isMain) {
      let file;
      try { file = Module._resolveFilename(request, parent, isMain); } catch (_e) { return load.apply(this, arguments); }
      if (file.includes('/src/') && loading.has(file)) bad.push(parent.filename + ' -> ' + file);
      const fresh = !require.cache[file];
      if (fresh && file.includes('/src/')) loading.add(file);
      try { return load.apply(this, arguments); } finally { loading.delete(file); }
    };
    require('./src/application');
    console.log(JSON.stringify([...new Set(bad)]));
  `;
  const result = spawnSync(process.execPath, ['-e', script], { cwd: require('path').join(__dirname, '..'), env: process.env, encoding: 'utf8' });
  assert.strictEqual(result.status, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout.trim().split('\n').pop()), [], 'application load must not hit a require cycle that returns partial exports');
  const planPricing = require('../src/payments/plan-pricing');
  assert.strictEqual(typeof planPricing.resolvePrice, 'function');
}

async function planCloneUsesNumberedPlaceholders() {
  // Regression: clonePlanVersion built placeholders as "6,7,8..." instead of "$6,$7,$8...",
  // so Postgres rejected every plan clone with a type error on allow_downloads.
  const db = require('../src/db');
  const original = db.transaction;
  const sql = [];
  db.transaction = async fn => fn({ query: async (text, params) => {
    const t = String(text);
    sql.push(t);
    if (/FROM plans WHERE id=\$1 FOR SHARE/.test(t)) return { rows: [{ id: 'p1', version_group_id: null, allow_downloads: true, streams: 2 }], rowCount: 1 };
    if (/information_schema\.columns/.test(t)) return { rows: [{ column_name: 'allow_downloads' }, { column_name: 'streams' }], rowCount: 2 };
    if (/MAX\(version_number\)/.test(t)) return { rows: [{ n: 2 }], rowCount: 1 };
    if (/INSERT INTO plans/.test(t)) return { rows: [{ id: 'p2' }], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  } });
  try {
    const modulePath = require.resolve('../src/catalog/plan-command-service');
    delete require.cache[modulePath];
    const planCommands = require('../src/catalog/plan-command-service');
    await planCommands.clonePlanVersion('p1', { code: 'clone-code', name: 'Clone' }, null);
    const insert = sql.find(t => /INSERT INTO plans/.test(t));
    assert(insert, 'clone must insert a plan');
    assert(/VALUES\(\$1,\$2,FALSE,FALSE,\$3,\$4,\$5,\$6,\$7\)/.test(insert.replace(/\s+/g, '')) || /\$6,\$7/.test(insert), `clone placeholders must be $-numbered (got ${insert})`);
    assert(!/\$5,6,7/.test(insert), 'clone placeholders must not be bare integers');
  } finally {
    db.transaction = original;
    delete require.cache[require.resolve('../src/catalog/plan-command-service')];
  }
}

(async () => {
  await planLibrariesSaveReachesCommandOwner();
  await bulkPaymentsSyncUsesCanonicalBillingControl();
  await asyncHandlerRejectionsReachErrorMiddleware();
  await pathGuardsIgnoreCaseAndTrailingSlash();
  await customerTwoFactorFailureCounterResetsAfterLockExpiry();
  await noRequireCycleHandsOutPartialExports();
  await planCloneUsesNumberedPlaceholders();
  console.log('deep audit regressions smoke: ok');
  process.exit(0);
})().catch(error => { console.error(error); process.exit(1); });
