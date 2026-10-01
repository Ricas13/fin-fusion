'use strict';

const assert = require('assert');
const { createOperator } = require('../src/access/access-integrity-operator');

(async () => {
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
