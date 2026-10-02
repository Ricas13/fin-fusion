'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { repairFindings } = require('../src/automation/revenue-integrity-repair');

(async () => {
  const calls = [];
  const operator = {
    canRepair(kind) {
      return ['free_plan_without_ready_server','free_server_without_plan','unpaid_trial_without_ready_server'].includes(kind);
    },
    async repairCurrent(input) {
      calls.push(input);
      if (input.id === 'stuck') throw new Error('synthetic repair failure');
      if (input.id === 'protected') return { applied: true, status: 'protected' };
      return { applied: true, status: input.id === 'ready' ? 'ready' : 'removed' };
    }
  };

  const result = await repairFindings([
    { kind:'free_plan_without_ready_server', id:'free-1', customerId:'customer-1' },
    { kind:'free_server_without_plan', id:'ready', customerId:'customer-2' },
    { kind:'unpaid_trial_without_ready_server', id:'protected', customerId:'customer-3' },
    { kind:'free_plan_without_ready_server', id:'stuck', customerId:'customer-4' },
    { kind:'paid_plan_without_recovery_state', id:'paid-1', customerId:'customer-5' }
  ], { operator });

  assert.strictEqual(result.attempted, 4, 'only operator-approved repairable findings may be attempted');
  assert.strictEqual(result.applied, 3);
  assert.strictEqual(result.repaired, 2);
  assert.strictEqual(result.unresolved, 2, 'protected and failed repairs must remain unresolved for the second scan');
  assert.strictEqual(result.errors.length, 1);
  assert.strictEqual(calls.length, 4);
  assert(!calls.some(call => call.id === 'paid-1'), 'paid/manual-review findings must never enter automatic repair');

  const jobs = fs.readFileSync(path.join(__dirname, '..', 'src/automation/jobs.js'), 'utf8');
  const repairAt = jobs.indexOf('revenueIntegrityRepair.repairFindings(findings)');
  const rescanAt = jobs.indexOf('scanned=await revenueIntegrity.scan();', repairAt + 1);
  const notifyAt = jobs.indexOf('revenueIntegrity.notify(findings)', repairAt + 1);
  assert(repairAt >= 0 && rescanAt > repairAt && notifyAt > rescanAt,
    'revenue integrity must repair, independently re-scan, then notify only unresolved findings');

  console.log('revenue integrity auto-repair smoke: ok');
})().catch(error => {
  console.error(error.stack || error);
  process.exit(1);
});
