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

const lifecycle = require('../src/payments/lifecycle');

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
    reset({
      plan: trialPlan(serviceType),
      jellyfin: entitlement(), emby: entitlement(), stremio: entitlement(),
      reconcile: async () => { throw lockTimeout(); }
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
    error => error.code === 'TRIAL_STREMIO_INSTALL_FAILED',
    'a real link failure must still fail the trial'
  );
  assert.strictEqual(cancelled().length, 1, 'a real link failure must still roll the trial back');
}

(async () => {
  await testRollbackLockTimeoutIsNotDestructive();
  await testActivationLockTimeoutKeepsTrial();
  await testStremioInstallLockTimeoutFallsThroughToActivation();
  console.log('unpaid trial rollback recheck smoke: ok');
})().catch(error => {
  console.error('unpaid trial rollback recheck smoke failed:', error);
  process.exit(1);
});
