'use strict';

const accessIntegrityOperator = require('../access/access-integrity-operator');

async function repairFindings(findings, { operator = accessIntegrityOperator } = {}) {
  const rows = Array.isArray(findings) ? findings : [];
  let attempted = 0;
  let applied = 0;
  let repaired = 0;
  let unresolved = 0;
  const errors = [];

  for (const finding of rows) {
    if (!operator.canRepair(finding?.kind)) continue;
    attempted += 1;
    try {
      const result = await operator.repairCurrent({
        kind: finding.kind,
        id: finding.id,
        customerId: finding.customerId
      });
      if (result?.applied) applied += 1;
      if (['ready', 'repaired', 'removed'].includes(String(result?.status || ''))) repaired += 1;
      else unresolved += 1;
    } catch (error) {
      unresolved += 1;
      errors.push({
        kind: String(finding?.kind || ''),
        id: String(finding?.id || ''),
        customerId: finding?.customerId || null,
        error: String(error?.message || error || 'Automatic integrity repair failed').slice(0, 500)
      });
    }
  }

  return { attempted, applied, repaired, unresolved, errors };
}

module.exports = { repairFindings };
