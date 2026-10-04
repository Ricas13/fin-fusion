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
    let rollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          {
            state: STATES.INCONSISTENT_UNPAID,
            entitlement: {
              subscription_id: 'sub-protected',
              permanent_access: true,
              admin_jellyfin_mode: null
            }
          },
          {
            state: STATES.INCONSISTENT_UNPAID,
            entitlement: {
              subscription_id: 'sub-protected',
              permanent_access: true,
              admin_jellyfin_mode: null
            }
          }
        ]
      }),
      provisioning: { reconcileCustomer: async () => { throw new Error('no eligible server'); } },
      lifecycle: () => ({ rollbackUnprovisionedFreeClaim: async () => { rollbacks += 1; } })
    });
    const result = await repair.repairFreeEntitlement('customer', 'sub-protected');
    assert.strictEqual(result.status, 'protected');
    assert.strictEqual(result.reason, 'admin_protected');
    assert.strictEqual(rollbacks, 0,
      'Permanent Access must never be cancelled by automatic Free entitlement repair');
  }

  {
    let rollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          {
            state: STATES.INCONSISTENT_UNPAID,
            entitlement: {
              subscription_id: 'sub-pinned',
              permanent_access: false,
              admin_jellyfin_mode: 'forced_server'
            }
          },
          {
            state: STATES.INCONSISTENT_UNPAID,
            entitlement: {
              subscription_id: 'sub-pinned',
              permanent_access: false,
              admin_jellyfin_mode: 'forced_server'
            }
          }
        ]
      }),
      provisioning: { reconcileCustomer: async () => { throw new Error('no eligible server'); } },
      lifecycle: () => ({ rollbackUnprovisionedFreeClaim: async () => { rollbacks += 1; } })
    });
    const result = await repair.repairFreeEntitlement('customer', 'sub-pinned');
    assert.strictEqual(result.status, 'removed');
    assert.strictEqual(rollbacks, 1,
      'server pin is placement-only and must not disable normal Free activation rollback');
  }

  {
    let trialRollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        primary: [{
          state: STATES.INCONSISTENT_UNPAID,
          entitlement: {
            subscription_id: 'trial-protected',
            billing_interval: 'trial',
            service_type: 'jellyfin',
            admin_jellyfin_mode: 'present'
          }
        }]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({
        rollbackUnprovisionedJellyfinTrial: async () => { trialRollbacks += 1; }
      })
    });
    const result = await repair.repairUnpaidTrial('customer');
    assert.strictEqual(result.status, 'protected');
    assert.strictEqual(result.reason, 'admin_protected');
    assert.strictEqual(trialRollbacks, 0,
      'explicit administrator-present access must never be cancelled by unpaid-trial repair');
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
    let rollbacks = 0;
    let reconciles = 0;
    const ambiguous = {
      state: STATES.INCONSISTENT_UNPAID,
      entitlement: { subscription_id: 'free-legacy-ambiguous' },
      accounts: [{ id: 'free-a', server_id: 'server-a' }, { id: 'free-b', server_id: 'server-b' }]
    };
    const repair = createAccessRepair({
      customerAccessState: accessState({ free: [ambiguous] }),
      provisioning: { reconcileCustomer: async () => { reconciles += 1; } },
      lifecycle: () => ({ rollbackUnprovisionedFreeClaim: async () => { rollbacks += 1; } })
    });
    const result = await repair.repairFreeEntitlement('customer', 'free-legacy-ambiguous');
    assert.strictEqual(result.status, 'protected');
    assert.strictEqual(result.reason, 'ambiguous_legacy_assignment');
    assert.strictEqual(reconciles, 0, 'ambiguous legacy Free access must require repair instead of guessing a server');
    assert.strictEqual(rollbacks, 0, 'ambiguous legacy Free access must never be cancelled automatically');
  }

  {
    let rollbacks = 0;
    const unavailable = {
      state: STATES.INCONSISTENT_UNPAID,
      entitlement: { subscription_id: 'free-assigned-unavailable', media_server_id: 'server-assigned' },
      accounts: [{ id: 'free-assigned', server_id: 'server-assigned', disabled: false, server_enabled: false }]
    };
    const repair = createAccessRepair({
      customerAccessState: accessState({ free: [unavailable, unavailable] }),
      provisioning: { reconcileCustomer: async () => { throw new Error('assigned server unavailable'); } },
      lifecycle: () => ({ rollbackUnprovisionedFreeClaim: async () => { rollbacks += 1; } })
    });
    const result = await repair.repairFreeEntitlement('customer', 'free-assigned-unavailable');
    assert.strictEqual(result.status, 'protected');
    assert.strictEqual(result.reason, 'assigned_server_account_unavailable');
    assert.strictEqual(rollbacks, 0, 'an outage on the persisted Free server must not cancel an existing Free entitlement');
  }

  {
    let trialRollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        primary: [{
          state: STATES.INCONSISTENT_UNPAID,
          entitlement: { subscription_id: 'trial-ambiguous', billing_interval: 'trial', service_type: 'jellyfin' },
          accounts: [{ id: 'trial-a', server_id: 'server-a' }, { id: 'trial-b', server_id: 'server-b' }]
        }]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({ rollbackUnprovisionedJellyfinTrial: async () => { trialRollbacks += 1; } })
    });
    const result = await repair.repairUnpaidTrial('customer');
    assert.strictEqual(result.status, 'protected');
    assert.strictEqual(result.reason, 'ambiguous_legacy_assignment');
    assert.strictEqual(trialRollbacks, 0, 'ambiguous legacy trials must require repair instead of destructive rollback');
  }

  {
    let trialRollbacks = 0;
    const repair = createAccessRepair({
      customerAccessState: accessState({
        primary: [{
          state: STATES.INCONSISTENT_UNPAID,
          entitlement: { subscription_id: 'trial-assigned', billing_interval: 'trial', service_type: 'jellyfin', media_server_id: 'server-assigned' },
          accounts: [{ id: 'trial-existing', server_id: 'server-assigned', server_enabled: false }]
        }]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({ rollbackUnprovisionedJellyfinTrial: async () => { trialRollbacks += 1; } })
    });
    const result = await repair.repairUnpaidTrial('customer');
    assert.strictEqual(result.status, 'protected');
    assert.strictEqual(result.reason, 'assigned_server_account_unavailable');
    assert.strictEqual(trialRollbacks, 0, 'an existing trial must not be cancelled merely because its assigned server is temporarily unavailable');
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

  {
    const rollbackCalls = [];
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          { state: STATES.INCONSISTENT_UNPAID, entitlement: { subscription_id: 'integrity-free' } },
          { state: STATES.INCONSISTENT_UNPAID, entitlement: { subscription_id: 'integrity-free' } }
        ]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({
        rollbackUnprovisionedFreeClaim: async (...args) => rollbackCalls.push(args)
      })
    });
    const result = await repair.repairIntegrityFinding({
      kind: 'free_plan_without_ready_server',
      id: 'integrity-free',
      customerId: 'integrity-customer'
    });
    assert.strictEqual(result.status, 'removed');
    assert.strictEqual(rollbackCalls.length, 1,
      'repairable Free integrity finding must delegate to exact-subscription Free repair');
    assert.strictEqual(rollbackCalls[0][1], 'integrity-free');
  }

  {
    const repair = createAccessRepair({
      customerAccessState: accessState(),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({})
    });
    await assert.rejects(
      repair.repairIntegrityFinding({
        kind: 'paid_plan_without_recovery_state',
        id: 'paid-subscription',
        customerId: 'paid-customer'
      }),
      error => error.code === 'ACCESS_INTEGRITY_REPAIR_MANUAL_REVIEW',
      'paid provisioning findings must never be routed through automatic destructive repair'
    );
  }


  {
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [{ state: STATES.ORPHAN_ACCOUNT, entitlement: null, account: { id: 'orphan-failed' } }]
      }),
      provisioning: { reconcileCustomer: async () => { throw new Error('server API unavailable'); } },
      lifecycle: () => ({})
    });
    await assert.rejects(
      repair.removeOrphanFreeAccount('customer'),
      /server API unavailable/,
      'orphan cleanup must not report success when reconciliation itself is uncertain'
    );
  }

  {
    const repair = createAccessRepair({
      customerAccessState: accessState({
        free: [
          { state: STATES.ORPHAN_ACCOUNT, entitlement: null, account: { id: 'orphan-stuck' } },
          { state: STATES.ORPHAN_ACCOUNT, entitlement: null, account: { id: 'orphan-stuck' } }
        ]
      }),
      provisioning: { reconcileCustomer: async () => {} },
      lifecycle: () => ({})
    });
    await assert.rejects(
      repair.removeOrphanFreeAccount('customer'),
      /remained after no-plan reconciliation/,
      'orphan cleanup must verify the destructive postcondition instead of trusting a successful reconcile call'
    );
  }

  console.log('access repair behavior smoke: ok');
})().catch(error => {
  console.error('access repair behavior smoke failed:', error);
  process.exit(1);
});
