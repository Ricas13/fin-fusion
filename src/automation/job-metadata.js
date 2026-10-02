'use strict';

const registry = require('./jobs');

// Compatibility-only read facade. The executable registry in jobs.js owns all
// scheduling metadata; this module deliberately carries no independent table.
const DEFAULT_INTERVAL_SECONDS = 300;

function names() { return registry.names(); }
function get(jobKey) {
  const definition = registry.definition(jobKey);
  if (!definition) return null;
  const { run, ...metadata } = definition;
  return metadata;
}
function criticalNames() { return registry.criticalNames(); }
function disableableCriticalNames() { return registry.disableableCriticalNames(); }

const JOB_METADATA = Object.freeze(Object.fromEntries(names().map(jobKey => [
  jobKey,
  Object.freeze(get(jobKey))
])));

module.exports = {
  DEFAULT_INTERVAL_SECONDS,
  JOB_METADATA,
  names,
  get,
  criticalNames,
  disableableCriticalNames
};
