'use strict';

// Behavioural smoke for the unpaid rollback paths in src/payments/lifecycle.js.
// The real lifecycle, activation helper and customer access state run against
// stubbed persistence and providers, so every destructive step is observable.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
function stub(relative, exports) {
  const filename = require.resolve(path.join(root, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CUSTOMER = 'customer-1';
const TRIAL = 'trial-sub';
let world;

function reset(overrides = {}) {
  world = {
    plan: null,
    jellyfin: null,
    free: null,
    emby: null,
    stremio: null,
    accounts: [],
    embyAccounts: [],
    row: { id: TRIAL, status: 'trialing', superseded_by: null, live: true },
    stremioEntitlement: null,
    credential: null,
    // One entry per customer lock acquisition: 'timeout' means the callback never runs.
    locks: [],
    lockDepth: 0,
    onLock: null,
    reconcile: async () => {},
    ensureInstallation: async () => {},
    deleted: [],
    writes: [],
    reads: [],
    reconciles: 0,
    requested: [],
    revoked: [],
    ...overrides
  };
}

function lockTimeout(code = 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT') {
  const error = new Error('Another reconciliation for this customer is still running. Try again shortly.');
  error.code = code;
  return error;
}

function note(name) {
  world.reads.push({ name, locked: world.lockDepth > 0 });
}

async function runQuery(sql, params = []) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  if (/^(INSERT|UPDATE|DELETE)/i.test(text)) {
    world.writes.push({ sql: text, params, locked: world.lockDepth > 0 });
  }
  if (/FROM plans p WHERE p\.code=\$1/.test(text)) return { rows: [world.plan], rowCount: 1 };
  if (/^SELECT code FROM plans/.test(text)) return { rows: [{ code: 'free' }], rowCount: 1 };
  if (/^SELECT 1 FROM subscriptions WHERE customer_id=\$1 AND plan_id=\$2/.test(text)) return { rows: [], rowCount: 0 };
  if (/FROM platform_settings/.test(text)) return { rows: [], rowCount: 0 };
  if (/^SELECT s\.service_type_snapshot,p\.service_type,p\.name FROM subscriptions/.test(text)) return { rows: [], rowCount: 0 };
  if (/^SELECT id FROM customers/.test(text)) return { rows: [{ id: CUSTOMER }], rowCount: 1 };
  if (/LEFT JOIN customer_entitlement_overrides o .* FOR UPDATE OF s/.test(text)) return { rows: [], rowCount: 0 };
  if (/^INSERT INTO subscriptions/.test(text)) return { rows: [{ id: TRIAL, customer_id: CUSTOMER }], rowCount: 1 };
  if (/FROM stremio_entitlements/.test(text) && /^SELECT/.test(text)) {
    note('stremioEntitlement');
    const row = world.stremioEntitlement;
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/^SELECT .* FROM subscriptions WHERE id=\$1 AND customer_id=\$2 AND superseded_by IS NULL/.test(text)) {
    const row = world.row && !world.row.superseded_by ? world.row : null;
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  }
  if (/^UPDATE subscriptions SET status='cancelled'/.test(text)) {
    const guarded = /superseded_by IS NULL/.test(text);
    if (!world.row || (guarded && world.row.superseded_by)) return { rows: [], rowCount: 0 };
    return { rows: [{ id: params[0], status: 'cancelled', superseded_by: world.row.superseded_by }], rowCount: 1 };
  }
  if (/^(INSERT|UPDATE|DELETE)/i.test(text)) return { rows: [], rowCount: 1 };
  throw new Error(`Unexpected query: ${text.slice(0, 200)}`);
}

stub('src/db.js', {
  query: runQuery,
  transaction: async fn => fn({ query: runQuery })
});
stub('src/payments/lifecycle-primitives.js', {
  reconcileCommittedCustomerStrict: async customerId => world.reconcile(customerId),
  reconcileCommittedCustomer: async () => null
});
stub('src/entitlements/subscription-state.js', {
  assertAudience: plan => plan,
  effectiveSubscription: async () => { note('jellyfin'); return world.jellyfin; },
  effectiveEmbySubscription: async () => { note('emby'); return world.emby; },
  effectiveStremioSubscription: async () => { note('stremio'); return world.stremio; },
  liveFreeJellyfinSubscription: async () => { note('free'); return world.free; },
  lockLiveFreeClaimSubscriptions: async () => [],
  markSuperseded: async () => {}
});
stub('src/entitlements/plan-capacity.js', {
  acquisitionSql: () => 'TRUE',
  lockAndAssert: async () => {}
});
stub('src/entitlements/plan-expiry.js', {
  endForPlan: () => new Date(Date.now() + 86400000),
  freeTierEnd: () => new Date(Date.now() + 86400000),
  isFreeTier: plan => plan?.is_free_tier === true
});
stub('src/jellyfin/customer-server-choice.js', {
  resolveAcquisitionLocation: async () => null,
  selectServerForLocationLocked: async () => null,
  mediaServerType: plan => {
    const type = String(plan?.service_type || 'jellyfin');
    if (type === 'emby') return 'emby';
    return type === 'jellyfin' || type === 'bundle' ? 'jellyfin' : null;
  }
});
stub('src/jellyfin/plan-servers.js', { eligibleServersForPlan: async () => [] });
stub('src/entitlements/inactivity-hold-reconciliation.js', { releaseObsoleteForCustomer: async () => 0 });
stub('src/payments/commerce-control.js', { assertOpen: async () => {} });
stub('src/stremio/foundation.js', { assertAcquirable: () => {} });
stub('src/jellyfin/resilient-provisioning.js', {
  reconciliationLock: {
    withCustomerReconciliationLock: async (_customerId, fn) => {
      const outcome = world.locks.shift();
      if (outcome === 'timeout') throw lockTimeout();
      assert.strictEqual(world.lockDepth, 0, 'the customer lock is not re-entrant');
      if (world.onLock) world.onLock();
      world.lockDepth += 1;
      try { return await fn(); }
      finally { world.lockDepth -= 1; }
    }
  },
  normalAccounts: async () => { note('accounts'); return world.accounts; },
  accountMatchesEntitlementPlacement: (account, entitlement) =>
    String(account.server_id) === String(entitlement.media_server_id),
  deleteJellyfinAccount: async account => { world.deleted.push(account.id); },
  reconcileCustomer: async () => {
    assert.strictEqual(world.lockDepth, 0, 'reconcileCustomer takes the customer lock and must not run inside it');
    world.reconciles += 1;
  },
  control: { requestCustomerReconcile: async customerId => { world.requested.push(customerId); } }
});
stub('src/jellyfin/media-service-reconciliation.js', {
  accountsFor: async () => { note('embyAccounts'); return world.embyAccounts; }
});
stub('src/stremio/entitlements.js', {
  ensureInstallationCredential: async () => world.ensureInstallation()
});
stub('src/stremio/install-credential-recovery.js', {
  current: async () => (world.credential ? { credential: world.credential } : null)
});
stub('src/stremio/external-playback-token.js', {
  revokeEntitlement: async id => { world.revoked.push(id); }
});
stub('src/stremio/managed-entitlements.js', {
  revokeCustomerInactiveMappings: async () => { world.revoked.push('mappings'); }
});
stub('src/payments/subscription-access-extensions.js', {});
// Only needed to load the registration module around activateRequestedFreeAccess.
let registrationClaim = null;
stub('src/customers.js', {});
stub('src/referrals.js', {});
stub('src/auth/customer-session.js', { establish: async () => {}, destroy: async () => {} });
stub('src/auth/csrf.js', { verify: () => true, token: () => 'token' });
stub('src/security/pending-registration.js', { consume: async () => registrationClaim });
stub('src/jellyfin/free-claim-provisioning.js', { ensureFreeClaimProvisioned: async () => ({ ready: true }) });
stub('src/integrations/email-settings.js', { status: async () => ({ configured: false }) });
stub('src/integrations/email-outbox.js', {});
stub('src/integrations/notification-dispatch.js', { dispatch: async () => {} });
stub('src/platform/runtime-settings.js', { ensureLoaded: async () => {}, siteName: () => 'Site' });
stub('src/platform/operations-settings.js', {});

const lifecycle = require('../src/payments/lifecycle');
const publicError = require('../src/platform/public-error');
const publicAuth = require('../src/platform/customer-public-auth');

function trialPlan(serviceType) {
  return { id: 'plan-1', code: 'trial', name: 'Trial', billing_interval: 'trial', service_type: serviceType };
}
function entitlement(extra = {}) {
  return { subscription_id: TRIAL, media_server_id: 'server-1', billing_interval: 'trial', ...extra };
}
function account(id, extra = {}) {
  return { id, server_id: 'server-1', access_lane: 'primary', disabled: false, server_enabled: true, ...extra };
}
function readyInstall() {
  world.stremioEntitlement = { id: 'entitlement-1', status: 'active', token_hash: 'hash' };
  world.credential = 'credential';
}
function assertUntouched(label) {
  assert.deepStrictEqual(world.deleted, [], `${label}: no media account may be deleted`);
  assert.deepStrictEqual(world.writes.map(write => write.sql), [], `${label}: nothing may be written`);
  assert.deepStrictEqual(world.revoked, [], `${label}: nothing may be revoked`);
  assert.strictEqual(world.reconciles, 0, `${label}: no compensating reconcile may run`);
}
function cancelled() {
  return world.writes.filter(write => /^UPDATE subscriptions SET status='cancelled'/.test(write.sql));
}
function audits() {
  return world.writes.filter(write => /^INSERT INTO audit_log/.test(write.sql) && /rolled_back/.test(write.sql));
}

const ROLLBACKS = [
  'rollbackUnprovisionedJellyfinTrial',
  'rollbackUnprovisionedEmbyTrial',
  'rollbackUnprovisionedFreeClaim',
  'rollbackUnprovisionedStremioTrial',
  'rollbackUnprovisionedBundleTrial'
];

async function testRollbackLockTimeoutIsNotDestructive() {
  for (const name of ROLLBACKS) {
    reset({
      jellyfin: entitlement(), free: entitlement(), emby: entitlement(), stremio: entitlement(),
      accounts: [account('primary'), account('free', { access_lane: 'free' })],
      embyAccounts: [account('emby')],
      locks: ['timeout']
    });
    await assert.rejects(
      lifecycle[name](CUSTOMER, TRIAL, { reason: 'busy' }),
      error => error.code === 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT',
      `${name} must surface the lock timeout`
    );
    // For the bundle this also proves the Stremio half (which would take the
    // next, free, lock) never ran.
    assertUntouched(name);
  }
}

async function testActivationLockTimeoutKeepsTrial() {
  for (const serviceType of ['jellyfin', 'emby', 'stremio', 'bundle']) {
    for(const failure of [lockTimeout(),new Error('no server capacity')]) {
    reset({
      plan: trialPlan(serviceType),
      jellyfin: entitlement(), emby: entitlement(), stremio: entitlement(),
      reconcile: async () => { throw failure; }
    });
    await assert.rejects(
      lifecycle.startFreeTrial(CUSTOMER, 'trial'),
      error => error.code === 'TRIAL_ACTIVATION_PENDING',
      `${serviceType} trial activation must report pending after a lock timeout`
    );
    assert.deepStrictEqual(cancelled(), [], `${serviceType}: a lock timeout must not cancel the trial`);
    assert.deepStrictEqual(world.deleted, [], `${serviceType}: a lock timeout must not delete accounts`);
    assert.deepStrictEqual(world.requested, [CUSTOMER], `${serviceType}: pending activation must queue a reconcile`);
    }
  }
}

async function testStremioInstallLockTimeoutFallsThroughToActivation() {
  reset({
    plan: trialPlan('stremio'),
    stremio: entitlement(),
    ensureInstallation: async () => { throw lockTimeout('STREMIO_OPERATION_LOCK_TIMEOUT'); },
    // The strict reconciliation that follows creates the link.
    reconcile: async () => { readyInstall(); }
  });
  const created = await lifecycle.startFreeTrial(CUSTOMER, 'trial');
  assert.strictEqual(created.id, TRIAL, 'a busy Stremio lock must not fail a trial that activates');
  assert.deepStrictEqual(cancelled(), [], 'a busy Stremio lock must not cancel the trial');
  assert.deepStrictEqual(world.revoked, [], 'a busy Stremio lock must not revoke the installation');

  reset({
    plan: trialPlan('stremio'),
    stremio: entitlement(),
    ensureInstallation: async () => { throw new Error('installation store unavailable'); },
    locks: ['timeout'],
    reconcile: async () => { throw lockTimeout(); }
  });
  await assert.rejects(
    lifecycle.startFreeTrial(CUSTOMER, 'trial'),
    error => error.code === 'TRIAL_ACTIVATION_PENDING',
    'a link failure whose rollback could not take the lock must end as pending'
  );
  assert.deepStrictEqual(cancelled(), []);

  reset({
    plan: trialPlan('stremio'),
    stremio: entitlement(),
    ensureInstallation: async () => { throw new Error('installation store unavailable'); }
  });
  await assert.rejects(
    lifecycle.startFreeTrial(CUSTOMER, 'trial'),
    error => error.code === 'TRIAL_ACTIVATION_PENDING',
    'a real link failure must retain the trial for retry'
  );
  assert.strictEqual(cancelled().length, 0, 'a real link failure must never roll the trial back');
  assert.deepStrictEqual(world.requested, [CUSTOMER]);
}

// One entry per single-service rollback: what it reads to judge readiness and
// what makes the trial pass the same readiness test activation uses.
const LANES = [
  {
    name: 'rollbackUnprovisionedJellyfinTrial', serviceType: 'jellyfin', key: 'jellyfin', read: 'accounts',
    makeReady: () => { world.accounts = [account('ready')]; }
  },
  {
    name: 'rollbackUnprovisionedEmbyTrial', serviceType: 'emby', key: 'emby', read: 'embyAccounts',
    makeReady: () => { world.embyAccounts = [account('ready')]; }
  },
  {
    name: 'rollbackUnprovisionedFreeClaim', key: 'free', read: 'accounts',
    makeReady: () => { world.accounts = [account('ready', { access_lane: 'free' })]; }
  },
  {
    name: 'rollbackUnprovisionedStremioTrial', serviceType: 'stremio', key: 'stremio', read: 'stremioEntitlement',
    makeReady: () => { readyInstall(); }
  }
];

async function testReadyUnderLockIsKept() {
  for (const lane of LANES) {
    // The account or link only appears once the lock is held.
    reset({ [lane.key]: entitlement() });
    world.onLock = () => lane.makeReady();
    const result = await lifecycle[lane.name](CUSTOMER, TRIAL, { reason: 'stale view', reservationId: 'reservation-1' });
    assert.deepStrictEqual(result, { rolledBack: false, reason: 'ready', subscriptionId: TRIAL }, lane.name);
    assertUntouched(`${lane.name} with ready access`);
    assert(world.reads.some(read => read.name === lane.read), `${lane.name} must read readiness`);
    assert(world.reads.every(read => read.locked), `${lane.name} must read access state under the customer lock`);
  }
}

async function testUnreadyStillRollsBack() {
  for (const lane of LANES) {
    reset({ [lane.key]: entitlement() });
    const result = await lifecycle[lane.name](CUSTOMER, TRIAL, { reason: 'unready' });
    assert.strictEqual(result.rolledBack, true, lane.name);
    assert.strictEqual(result.id, TRIAL, `${lane.name} must keep returning the closed row`);
    assert.strictEqual(cancelled().length, 1, lane.name);
    assert(/superseded_by IS NULL/.test(cancelled()[0].sql), `${lane.name} must guard replaced rows`);
    assert.strictEqual(audits().length, 1, lane.name);
  }
}

async function testOnlyOwnLaneAccountsAreDeleted() {
  const accounts = [
    account('disabled', { disabled: true }),
    account('wrong-server', { server_id: 'server-2' }),
    account('legacy', { access_lane: null, server_id: 'server-3' }),
    account('free', { access_lane: 'free' })
  ];
  reset({ jellyfin: entitlement(), accounts });
  await lifecycle.rollbackUnprovisionedJellyfinTrial(CUSTOMER, TRIAL);
  assert.deepStrictEqual(world.deleted, ['disabled', 'wrong-server', 'legacy'],
    'trial rollback deletes the same primary-lane accounts as before and never the Free account');
}

async function testBlockedTrials() {
  for (const lane of LANES) {
    reset({ [lane.key]: entitlement({ blocked: true }) });
    const kept = await lifecycle[lane.name](CUSTOMER, TRIAL, { retainBlocked: true });
    assert.deepStrictEqual(kept, { rolledBack: false, reason: 'blocked', subscriptionId: TRIAL }, lane.name);
    assertUntouched(`${lane.name} blocked, background`);

    reset({ [lane.key]: entitlement({ blocked: true }) });
    const closed = await lifecycle[lane.name](CUSTOMER, TRIAL);
    assert.strictEqual(closed.rolledBack, true, `${lane.name}: activation still rolls a blocked trial back`);
  }
}

async function testOperatorProtection() {
  const cases = [
    ['rollbackUnprovisionedJellyfinTrial', 'jellyfin', { permanent_access: true }],
    ['rollbackUnprovisionedEmbyTrial', 'emby', { access_expires_at: Infinity }],
    ['rollbackUnprovisionedStremioTrial', 'stremio', { access_expires_at: Infinity }],
    ['rollbackUnprovisionedFreeClaim', 'free', { admin_jellyfin_mode: 'present' }]
  ];
  for (const [name, key, protection] of cases) {
    reset({ [key]: entitlement(protection), accounts: [account('a')], embyAccounts: [account('b')] });
    await assert.rejects(lifecycle[name](CUSTOMER, TRIAL),
      error => error.code === 'OPERATOR_PROTECTED_ACCESS_ROLLBACK_BLOCKED', name);
    assert.deepStrictEqual(world.deleted, [], name);
    assert.deepStrictEqual(world.writes, [], name);
    assert.deepStrictEqual(world.revoked, [], name);
  }
}

async function testSupersededTrialIsNeverRewritten() {
  for (const lane of LANES) {
    reset({ row: { id: TRIAL, status: 'trialing', superseded_by: 'newer-sub', live: true } });
    const result = await lifecycle[lane.name](CUSTOMER, TRIAL, { reservationId: 'reservation-1' });
    assert.deepStrictEqual(result, { rolledBack: false, reason: 'not_current', subscriptionId: TRIAL }, lane.name);
    assert.deepStrictEqual(audits(), [], `${lane.name}: no audit for a replaced trial`);
    assert(world.writes.every(write => /^UPDATE subscriptions .*superseded_by IS NULL/.test(write.sql)),
      `${lane.name}: only the guarded no-op update may be attempted`);
    assert.deepStrictEqual(world.deleted, [], lane.name);
    assert.deepStrictEqual(world.revoked, [], lane.name);
    assert.strictEqual(world.reconciles, 0, lane.name);
  }
}

async function testStremioClosedTrialIsStillCleanedUp() {
  // The bundle path closes the subscription first; a leftover link must still go.
  reset({ row: { id: TRIAL, status: 'cancelled', superseded_by: null, live: false } });
  readyInstall();
  const result = await lifecycle.rollbackUnprovisionedStremioTrial(CUSTOMER, TRIAL);
  assert.strictEqual(result.rolledBack, true);
  assert.deepStrictEqual(world.revoked, ['entitlement-1', 'mappings']);
}

async function testBundle() {
  reset({ jellyfin: entitlement(), accounts: [account('ready')] });
  readyInstall();
  let result = await lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL);
  assert.strictEqual(result.reason, 'ready');
  assertUntouched('ready bundle');

  // Activation is strict: Jellyfin without an installation link is not ready.
  reset({ jellyfin: entitlement(), accounts: [account('ready')] });
  result = await lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL);
  assert.strictEqual(result.rolledBack, true);
  assert.deepStrictEqual(world.deleted, ['ready']);

  // A caller that only judges the media half keeps a working media account.
  reset({ jellyfin: entitlement(), accounts: [account('ready')] });
  result = await lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL, { requireStremioInstall: false });
  assert.strictEqual(result.reason, 'ready');
  assertUntouched('bundle with ready media');

  // A superseded media half means the Stremio half must not run.
  reset({ row: { id: TRIAL, status: 'trialing', superseded_by: 'newer-sub', live: true } });
  result = await lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL);
  assert.strictEqual(result.reason, 'not_current');
  assert.deepStrictEqual(audits(), []);
  assert.deepStrictEqual(world.revoked, []);

  // Operator protection and unreadable readiness stop before the Stremio half.
  reset({ jellyfin: entitlement({ permanent_access: true }), accounts: [account('kept')] });
  await assert.rejects(lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL),
    error => error.code === 'OPERATOR_PROTECTED_ACCESS_ROLLBACK_BLOCKED');
  assert.deepStrictEqual(world.writes, []);
  assert.deepStrictEqual(world.revoked, []);

  reset({ jellyfin: entitlement() });
  world.onLock = () => {
    Object.defineProperty(world, 'accounts', { configurable: true, get() { throw new Error('read failed'); } });
  };
  await assert.rejects(lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL), /read failed/);
  assert.deepStrictEqual(world.deleted, []);
  assert.deepStrictEqual(world.writes, []);
  assert.deepStrictEqual(world.revoked, []);

  // A real, unready bundle is still removed from both halves.
  reset({ jellyfin: entitlement(), stremio: entitlement(), stremioEntitlement: { id: 'entitlement-1' } });
  result = await lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL);
  assert.strictEqual(result.rolledBack, true);
  assert.deepStrictEqual(world.revoked, ['entitlement-1', 'mappings']);

  // Once the media half closed the trial, a busy Stremio half is not "pending".
  reset({ jellyfin: entitlement(), locks: ['ok', 'timeout'] });
  await assert.rejects(lifecycle.rollbackUnprovisionedBundleTrial(CUSTOMER, TRIAL),
    error => error.code === 'TRIAL_BUNDLE_ROLLBACK_INCOMPLETE' && !error.cause);
}

async function testActivationSucceedsWhenAccessAppearsBeforeRollback() {
  for (const lane of LANES.filter(item => item.serviceType)) {
    reset({ plan: trialPlan(lane.serviceType), [lane.key]: entitlement() });
    world.onLock = () => lane.makeReady();
    const created = await lifecycle.startFreeTrial(CUSTOMER, 'trial');
    assert.strictEqual(created.id, TRIAL, `${lane.serviceType} activation`);
    assert.deepStrictEqual(cancelled(), [], `${lane.serviceType} activation`);
    assert.deepStrictEqual(world.deleted, [], `${lane.serviceType} activation`);
  }
}

function freePlan() {
  return { id: 'free-plan', code: 'free', name: 'Free', billing_interval: 'month', price_minor: 0, is_free_tier: true, service_type: 'jellyfin' };
}

function customerCopy(error) {
  return publicError.present(error, { context: 'smoke', fallback: 'Your trial could not be started.' });
}

async function testCustomerMessages() {
  reset({ plan: trialPlan('jellyfin'), jellyfin: entitlement(), reconcile: async () => { throw lockTimeout(); } });
  await assert.rejects(lifecycle.startFreeTrial(CUSTOMER, 'trial'), error => {
    const shown = customerCopy(error);
    assert(shown.exposed, 'a pending trial must be readable');
    assert(/trial was created, but setup has not finished/.test(shown.message));
    assert(!/retry|retrying|removed automatically|Reference/i.test(shown.message),
      'the pending message must not promise a retry or removal');
    return true;
  });

  reset({ plan: trialPlan('jellyfin'), jellyfin: entitlement(), reconcile: async () => { throw new Error('upstream 500 secret'); } });
  await assert.rejects(lifecycle.startFreeTrial(CUSTOMER, 'trial'), error => {
    const shown = customerCopy(error);
    assert(shown.exposed);
    assert.strictEqual(shown.message,
      'The Jellyfin trial could not be activated because a server account could not be created. No trial plan was retained.');
    return true;
  });

  reset({ plan: trialPlan('stremio'), stremio: entitlement(), ensureInstallation: async () => { throw new Error('secret'); } });
  await assert.rejects(lifecycle.startFreeTrial(CUSTOMER, 'trial'),
    error => customerCopy(error).exposed && !/secret/.test(error.message));

  reset({ plan: freePlan(), free: entitlement(), reconcile: async () => { throw lockTimeout(); } });
  await assert.rejects(lifecycle.claimFreePlan(CUSTOMER, 'free'), error => {
    assert.strictEqual(error.code, 'FREE_CLAIM_ACTIVATION_PENDING');
    assert(customerCopy(error).exposed);
    // These phrases make other callers treat the claim as expired or already settled.
    assert(!/hold has expired|already have free access|already been claimed|retry/i.test(error.message));
    return true;
  });
  assert.deepStrictEqual(cancelled(), []);

  const created = { freeAccessRequested: true, customer: { id: CUSTOMER }, user: {} };
  reset({ plan: freePlan(), free: entitlement(), reconcile: async () => { throw lockTimeout(); } });
  const outcome = await publicAuth.activateRequestedFreeAccess(created);
  assert.strictEqual(outcome.pending, true);
  assert.strictEqual(outcome.activated, false);
  assert(/claim was saved, but setup has not finished/.test(outcome.error));

  reset({ plan: freePlan(), free: entitlement(), reconcile: async () => { throw lockTimeout(); } });
  registrationClaim = created;
  const route = publicAuth.createCustomerPublicAuthRouter().stack.find(layer =>
    layer.route?.path === '/account/verify-registration' && layer.route.methods.post).route.stack[0].handle;
  let location = null;
  await route({ body: { token: 't' }, session: {} }, { redirect: url => { location = url; } }, error => { throw error; });
  assert(location.startsWith('/account?message='), `pending registration must be shown as information: ${location}`);
  assert(/claim was saved/.test(decodeURIComponent(location)));

  const router = require('fs').readFileSync(path.join(root, 'src/platform/router.js'), 'utf8');
  assert.strictEqual(router.split("PENDING_ACTIVATION_CODES.has(error?.code) ? 'message' : 'error'").length - 1, 2,
    'both customer activation routes must show a pending outcome as information');
}

(async () => {
  await testCustomerMessages();
  await testReadyUnderLockIsKept();
  await testUnreadyStillRollsBack();
  await testOnlyOwnLaneAccountsAreDeleted();
  await testBlockedTrials();
  await testOperatorProtection();
  await testSupersededTrialIsNeverRewritten();
  await testStremioClosedTrialIsStillCleanedUp();
  await testBundle();
  await testActivationSucceedsWhenAccessAppearsBeforeRollback();
  await testRollbackLockTimeoutIsNotDestructive();
  await testActivationLockTimeoutKeepsTrial();
  await testStremioInstallLockTimeoutFallsThroughToActivation();
  console.log('unpaid trial rollback recheck smoke: ok');
})().catch(error => {
  console.error('unpaid trial rollback recheck smoke failed:', error);
  process.exit(1);
});
