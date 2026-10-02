'use strict';

const registry = require('./jobs');

// Compatibility-only facade. Criticality is owned by the canonical executable
// job registry; keeping these exports prevents older callers from breaking.
const CUSTOMER_ACCESS_CRITICAL_JOBS = Object.freeze(registry.criticalNames());
const DISABLEABLE_CRITICAL_JOBS = Object.freeze(registry.disableableCriticalNames());

function names() { return registry.criticalNames(); }
function isCritical(jobKey) { return registry.isCritical(jobKey); }
function mayBeDisabled(jobKey) { return registry.mayBeDisabled(jobKey); }

module.exports = {
  CUSTOMER_ACCESS_CRITICAL_JOBS,
  DISABLEABLE_CRITICAL_JOBS,
  names,
  isCritical,
  mayBeDisabled
};
