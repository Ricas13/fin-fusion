'use strict';

const assert = require('assert');
const { createOperator } = require('../src/access/access-integrity-operator');
const integrity = require('../src/access/access-integrity');
const { createAccessRepair } = require('../src/access/access-repair');
const { ACCESS_STATES } = require('../src/access/customer-access-state');

(async () => {
  {
    // Exercise the actual scanner mapper through the operator and repair owner.
    // A customer ID cannot stand in for the exact subscription being repaired.
    const finding = integrity.finding('free_plan_without_ready_server', {
      customer_id: 'customer-free', subscription_id: 'subscription-free'
    }, 'missing Free account');
    assert.strictEqual(finding.id, 'subscription-free');
    assert.strictEqual(integrity.finding('free_server_without_plan', {
      id: 'account-free', customer_id: 'customer-free'
    }, '').id, 'account-free');
    let reconciliations = 0;
    const repair = createAccessRepair({
      customerAccessState: {
        ACCESS_STATES,
        freeJellyfin: async () => ({
          state: reconciliations ? ACCESS_STATES.ACTIVE_READY : ACCESS_STATES.INCONSISTENT_UNPAID,
          entitlement: { subscription_id: 'subscription-free' },
          account: reconciliations ? { id: 'account-free' } : null
        })
      },
      provisioning: { reconcileCustomer: async id => {
        assert.strictEqual(id, 'customer-free');
        reconciliations++;
      } }
    });
    const operator = createOperator({ scan: async () => [finding], repair: repair.repairIntegrityFinding });
    const result = await operator.repairCurrent(finding);
    assert.strictEqual(result.status, 'repaired');
    assert.strictEqual(reconciliations, 1);
    assert.strictEqual(result.result.account.id, 'account-free');
  }
  {
    const scans = [];
    const repairs = [];
    const finding = {
      kind: 'free_plan_without_ready_server',
      id: 'sub-free',
      customerId: 'customer-free',
      detail: 'missing'
    };
    const operator = createOperator({
      scan: async options => {
        scans.push(options);
        return [finding];
      },
      repair: async value => {
        repairs.push(value);
        return { status: 'removed' };
      }
    });
    assert.strictEqual(operator.canRepair(finding.kind), true);
    assert.strictEqual(operator.label(finding.kind), 'Free plan without ready server');
    const result = await operator.repairCurrent({
      kind: finding.kind,
      id: finding.id,
      customerId: finding.customerId
    });
    assert.deepStrictEqual(scans, [{ limit: 500 }], 'repair must re-scan current independent findings');
    assert.deepStrictEqual(repairs, [finding], 'repair must receive the exact current scanner finding');
    assert.strictEqual(result.applied, true);
    assert.strictEqual(result.status, 'removed');
  }

  {
    let repaired = false;
    const operator = createOperator({
      scan: async () => [],
      repair: async () => { repaired = true; }
    });
    const result = await operator.repairCurrent({
      kind: 'free_server_without_plan',
      id: 'account-old',
      customerId: 'customer-old'
    });
    assert.deepStrictEqual(result, { applied: false, status: 'stale' });
    assert.strictEqual(repaired, false, 'stale rendered finding must never mutate access');
  }

  {
    let scanned = false;
    let repaired = false;
    const operator = createOperator({
      scan: async () => { scanned = true; return []; },
      repair: async () => { repaired = true; }
    });
    await assert.rejects(
      operator.repairCurrent({
        kind: 'paid_plan_without_recovery_state',
        id: 'paid-sub',
        customerId: 'paid-customer'
      }),
      error => error.code === 'ACCESS_INTEGRITY_REPAIR_MANUAL_REVIEW'
    );
    assert.strictEqual(scanned, false, 'paid/manual findings must be refused before any repair scan');
    assert.strictEqual(repaired, false, 'paid/manual findings must never enter automatic repair');
  }

  {
    let scanned = false;
    let repaired = false;
    const operator = createOperator({
      scan: async () => { scanned = true; return []; },
      repair: async () => { repaired = true; }
    });
    assert.strictEqual(operator.label('free_restore_reprovision_failed'), 'Free restore reprovisioning failed');
    assert.strictEqual(operator.canRepair('free_restore_reprovision_failed'), false);
    await assert.rejects(
      operator.repairCurrent({
        kind: 'free_restore_reprovision_failed',
        id: 'restore-hold',
        customerId: 'restore-customer'
      }),
      error => error.code === 'ACCESS_INTEGRITY_REPAIR_MANUAL_REVIEW'
    );
    assert.strictEqual(scanned, false, 'failed explicit restore must require operator review before any repair scan');
    assert.strictEqual(repaired, false, 'failed explicit restore must never enter generic automatic repair');
  }

  {
    const operator = createOperator({
      scan: async ({ limit }) => [{ id: String(limit) }],
      repair: async () => ({})
    });
    assert.deepStrictEqual(await operator.list({ limit: 37 }), [{ id: '37' }]);
  }

  console.log('access integrity operator behavior smoke: ok');
})().catch(error => {
  console.error('access integrity operator behavior smoke failed:', error);
  process.exit(1);
});
