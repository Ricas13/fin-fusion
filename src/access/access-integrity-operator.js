'use strict';

const accessIntegrity = require('./access-integrity');
const accessRepair = require('./access-repair');

const LABELS = Object.freeze({
  free_plan_without_ready_server: 'Free plan without ready server',
  free_restore_reprovision_failed: 'Free restore reprovisioning failed',
  free_server_without_plan: 'Free server account without plan',
  unpaid_trial_without_ready_server: 'Unpaid trial without ready server',
  primary_server_without_plan: 'Primary server account without plan',
  paid_plan_without_recovery_state: 'Paid plan missing recovery state'
});

const AUTO_REPAIRABLE = Object.freeze(new Set([
  'free_plan_without_ready_server',
  'free_server_without_plan',
  'unpaid_trial_without_ready_server'
]));

function createOperator(deps = {}) {
  const scan = deps.scan || accessIntegrity.scan;
  const repair = deps.repair || accessRepair.repairIntegrityFinding;

  function label(kind) {
    const key = String(kind || '');
    return LABELS[key] || key;
  }

  function canRepair(kind) {
    return AUTO_REPAIRABLE.has(String(kind || ''));
  }

  async function list({ limit = 100 } = {}) {
    return scan({ limit });
  }

  async function repairCurrent({ kind, id, customerId }) {
    const normalized = {
      kind: String(kind || ''),
      id: String(id || ''),
      customerId: String(customerId || '')
    };
    if (!canRepair(normalized.kind)) {
      const error = new Error('This access integrity finding requires manual review.');
      error.code = 'ACCESS_INTEGRITY_REPAIR_MANUAL_REVIEW';
      throw error;
    }
    if (!normalized.id || !normalized.customerId) {
      const error = new Error('Access integrity repair requires an exact finding and customer identity.');
      error.code = 'ACCESS_INTEGRITY_REPAIR_INVALID_FINDING';
      throw error;
    }

    // Never mutate a finding rendered on an earlier page load without proving
    // that the same independent scanner finding still exists now.
    const current = await scan({ limit: 500 });
    const finding = current.find(item =>
      String(item?.kind || '') === normalized.kind
      && String(item?.id || '') === normalized.id
      && String(item?.customerId || '') === normalized.customerId
    );
    if (!finding) return { applied: false, status: 'stale' };

    const result = await repair(finding);
    return {
      applied: true,
      status: String(result?.status || 'ok'),
      finding,
      result
    };
  }

  return { label, canRepair, list, repairCurrent };
}

const operator = createOperator();

module.exports = {
  LABELS,
  AUTO_REPAIRABLE,
  createOperator,
  ...operator
};
