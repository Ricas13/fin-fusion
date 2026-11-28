'use strict';

// Behavioural smoke for the entitlement worker in src/jellyfin/jobs.js: what it
// does with a customer whose reconciliation threw.
const assert = require('assert');
const path = require('path');

const root = path.join(__dirname, '..');
function stub(relative, exports) {
  const filename = require.resolve(path.join(root, relative));
  require.cache[filename] = { id: filename, filename, loaded: true, exports };
}

const CUSTOMER = '11111111-1111-4111-8111-111111111111';
let world;

function reset(overrides = {}) {
  world = {
    reconcileError: null,
    state: { status: 'pending' },
    problems: [],
    repairs: [],
    repair: async () => ({ status: 'skipped' }),
    ...overrides
  };
}

stub('src/db.js', {
  query: async sql => {
    if (/FROM customer_provisioning_state cps WHERE/.test(String(sql).replace(/\s+/g, ' '))) {
      return { rows: [{ customer_id: CUSTOMER }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
});
stub('src/automation/scan-cursor.js', {
  load: async () => null,
  save: async () => {},
  clear: async () => {}
});
stub('src/jellyfin/registry.js', {});
stub('src/jellyfin/resilient-provisioning.js', {
  reconcileCustomer: async () => { if (world.reconcileError) throw world.reconcileError; },
  control: {
    getCustomerState: async () => world.state,
    classifyError: () => ({ status: 'failed' }),
    markCustomerProblem: async (customerId, status, error) => {
      world.problems.push({ customerId, status, error });
      world.state = { status };
    }
  }
});
stub('src/access/access-repair.js', {
  repairUnpaidTrial: async (customerId, options) => {
    world.repairs.push({ lane: 'jellyfin', customerId, options });
    return world.repair('jellyfin');
  },
  repairUnpaidServiceTrial: async (customerId, lane, options) => {
    world.repairs.push({ lane, customerId, options });
    return world.repair(lane);
  }
});

const jobs = require('../src/jellyfin/jobs');

function failure(message, code) {
  const error = new Error(message);
  if (code) error.code = code;
  return error;
}

async function testLockTimeoutNeverRepairs() {
  for (const error of [
    failure('busy', 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT'),
    failure('busy', 'STREMIO_OPERATION_LOCK_TIMEOUT'),
    Object.assign(failure('wrapped'), { cause: failure('busy', 'CUSTOMER_RECONCILIATION_LOCK_TIMEOUT') })
  ]) {
    reset({ reconcileError: error, repair: async () => ({ status: 'removed' }) });
    const result = await jobs.reconcileActiveEntitlements({ limit: 10, concurrency: 1 });
    assert.deepStrictEqual(world.repairs, [], 'a lock timeout must never reach unpaid repair');
    assert.strictEqual(result.failed, 1, 'a lock timeout still counts as a failed pass');
    assert.strictEqual(world.problems.length, 1, 'a lock timeout must still persist retry backoff');
    assert.strictEqual(world.problems[0].error, error);
  }
}

async function testRealFailureStillRepairs() {
  const error = failure('no eligible server');
  reset({ reconcileError: error });
  const result = await jobs.reconcileActiveEntitlements({ limit: 10, concurrency: 1 });
  assert.strictEqual(world.repairs[0].options.cause, error, 'repair must receive the original error');
  assert.strictEqual(world.repairs[0].options.reason, 'no eligible server');
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(world.problems.length, 1);
  assert.deepStrictEqual(world.repairs.map(call => call.lane), ['jellyfin', 'emby', 'stremio'],
    'every unpaid lane must have the worker as its repair owner');
  assert(world.repairs.every(call => call.options.cause === error && call.customerId === CUSTOMER));
}

async function testAnyRemovedLaneSucceeds() {
  for (const lane of ['jellyfin', 'emby', 'stremio']) {
    reset({
      reconcileError: failure('no eligible server'),
      repair: async current => ({ status: current === lane ? 'removed' : 'skipped' })
    });
    const result = await jobs.reconcileActiveEntitlements({ limit: 10, concurrency: 1 });
    assert.strictEqual(result.succeeded, 1, `${lane} removal`);
    assert.deepStrictEqual(world.problems, [], `${lane}: a removed trial needs no backoff`);
  }
}

async function testDeferredOrFailedRepairKeepsBackoff() {
  reset({
    reconcileError: failure('no eligible server'),
    repair: async () => ({ status: 'deferred', reason: 'activation_grace' })
  });
  let result = await jobs.reconcileActiveEntitlements({ limit: 10, concurrency: 1 });
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(world.problems.length, 1, 'a deferred trial must stay in the retry queue');

  const original = failure('no eligible server');
  reset({
    reconcileError: original,
    repair: async lane => {
      if (lane === 'jellyfin') throw failure('repair read failed');
      return { status: 'skipped' };
    }
  });
  result = await jobs.reconcileActiveEntitlements({ limit: 10, concurrency: 1 });
  assert.strictEqual(world.repairs.length, 3, 'one failing lane must not stop the others');
  assert.strictEqual(result.failed, 1);
  assert.strictEqual(world.problems[0].error, original, 'backoff must record the original failure');
}

(async () => {
  await testLockTimeoutNeverRepairs();
  await testRealFailureStillRepairs();
  await testAnyRemovedLaneSucceeds();
  await testDeferredOrFailedRepairKeepsBackoff();
  console.log('entitlement reconcile lock timeout smoke: ok');
})().catch(error => {
  console.error('entitlement reconcile lock timeout smoke failed:', error);
  process.exit(1);
});
