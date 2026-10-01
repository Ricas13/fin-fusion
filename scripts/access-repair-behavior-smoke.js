'use strict';

const assert = require('assert');
const { createAccessRepair } = require('../src/access/access-repair');

const STATES = {
  ACTIVE_READY: 'ACTIVE_READY',
  ACTIVE_BLOCKED: 'ACTIVE_BLOCKED',
  INCONSISTENT_UNPAID: 'INCONSISTENT_UNPAID',
  ORPHAN_ACCOUNT: 'ORPHAN_ACCOUNT',
  NONE: 'NONE'
};

function accessState({ free = [], primary = [] } = {}) {
  return {
    ACCESS_STATES: STATES,
    async freeJellyfin() {
      if (!free.length) throw new Error('unexpected Free state read');
      return free.shift();
    },
    async primaryJellyfin() {
      if (!primary.length) throw new Error('unexpected primary state read');
      return primary.shift();
    }
  };
}

(async () => {
  {
    let reconciles = 0;
    let rollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [{ state: STATES.ACTIVE_BLOCKED, entitlement: { subscription_id: 'sub-blocked' } }]
      }),
      provisioning: { reconcileCustomer: async () => { reconciles += 1; } },
      lifecycle: () => ({ rollbackUnprovisionedFreeClaim: async () => { rollbacks += 1; } })
    });
    const result = await repair.repairFreeEntitlement('customer', 'sub-blocked');
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'blocked' });
    assert.strictEqual(reconciles, 0, 'blocked access must not be provisioned');
    assert.strictEqual(rollbacks, 0, 'blocked access must not be rolled back');
  }

  {
    let rollbacks = 0;
    const account = { id: 'ready-account' };
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          { state: STATES.INCONSISTENT_UNPAID, entitlement: { subscription_id: 'sub-repair' } },
          { state: STATES.ACTIVE_READY, entitlement: { subscription_id: 'sub-repair' }, account }
        ]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({ rollbackUnprovisionedFreeClaim: async () => { rollbacks += 1; } })
    });
    const result = await repair.repairFreeEntitlement('customer', 'sub-repair');
    assert.strictEqual(result.status, 'repaired');
    assert.strictEqual(result.account, account);
    assert.strictEqual(rollbacks, 0, 'successful convergence must never roll back');
  }

  {
    let rollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          { state: STATES.INCONSISTENT_UNPAID, entitlement: { subscription_id: 'sub-old' } },
          { state: STATES.INCONSISTENT_UNPAID, entitlement: { subscription_id: 'sub-new' } }
        ]
      }),
      provisioning: { reconcileCustomer: async () => { throw new Error('timeout after mutation'); } },
      lifecycle: () => ({ rollbackUnprovisionedFreeClaim: async () => { rollbacks += 1; } })
    });
    const result = await repair.repairFreeEntitlement('customer', 'sub-old');
    assert.deepStrictEqual(result, { status: 'skipped', reason: 'subscription_changed_after_reconcile' });
    assert.strictEqual(rollbacks, 0, 'a replacement subscription must survive repair of an older episode');
  }

  {
    const rollbackCalls = [];
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          { state: STATES.INCONSISTENT_UNPAID, entitlement: { subscription_id: 'sub-failed' } },
          { state: STATES.INCONSISTENT_UNPAID, entitlement: { subscription_id: 'sub-failed' } }
        ]
      }),
      provisioning: { reconcileCustomer: async () => { throw new Error('no eligible server'); } },
      lifecycle: () => ({
        rollbackUnprovisionedFreeClaim: async (...args) => rollbackCalls.push(args)
      })
    });
    const result = await repair.repairFreeEntitlement('customer', 'sub-failed', { reason: 'fallback' });
    assert.strictEqual(result.status, 'removed');
    assert.strictEqual(rollbackCalls.length, 1);
    assert.strictEqual(rollbackCalls[0][1], 'sub-failed', 'rollback must remain exact-subscription scoped');
    assert.strictEqual(rollbackCalls[0][2].reason, 'no eligible server', 'reconcile failure must remain the rollback reason');
  }

  {
    let trialRollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        primary: [{
          state: STATES.INCONSISTENT_UNPAID,
          entitlement: { subscription_id: 'trial-1', billing_interval: 'trial', service_type: 'jellyfin' }
        }]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({
        rollbackUnprovisionedJellyfinTrial: async (_customer, subscriptionId) => {
          assert.strictEqual(subscriptionId, 'trial-1');
          trialRollbacks += 1;
        }
      })
    });
    const result = await repair.repairUnpaidTrial('customer');
    assert.strictEqual(result.status, 'removed');
    assert.strictEqual(trialRollbacks, 1);
  }

  {
    let trialRollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        primary: [{
          state: STATES.INCONSISTENT_UNPAID,
          entitlement: { subscription_id: 'paid-1', billing_interval: 'month', service_type: 'jellyfin' }
        }]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({
        rollbackUnprovisionedJellyfinTrial: async () => { trialRollbacks += 1; }
      })
    });
    const result = await repair.repairUnpaidTrial('customer');
    assert.strictEqual(result.status, 'skipped');
    assert.strictEqual(trialRollbacks, 0, 'paid access must never enter unpaid-trial rollback');
  }

  {
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          { state: STATES.ORPHAN_ACCOUNT, entitlement: null, account: { id: 'orphan' } },
          { state: STATES.NONE, entitlement: null, account: null }
        ]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({})
    });
    const result = await repair.removeOrphanFreeAccount('customer');
    assert.strictEqual(result.status, 'removed');
  }

  console.log('access repair behavior smoke: ok');
})().catch(error => {
  console.error('access repair behavior smoke failed:', error);
  process.exit(1);
});
