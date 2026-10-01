'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registry = require('../src/automation/jobs');
const criticalJobs = require('../src/automation/critical-jobs');

const names = registry.names();
assert(names.length > 0, 'automation registry must expose jobs');

for (const jobKey of names) {
  const definition = registry.definition(jobKey);
  assert(definition, `${jobKey} must expose a definition`);
  assert.strictEqual(typeof definition.run, 'function', `${jobKey} must expose its run function`);
  assert(Number.isFinite(Number(definition.defaultIntervalSeconds)) && Number(definition.defaultIntervalSeconds) >= 30,
    `${jobKey} must expose a bounded default interval`);
  assert.strictEqual(typeof definition.critical, 'boolean', `${jobKey} must declare whether it is critical`);
  assert(!Object.prototype.hasOwnProperty.call(definition, 'timeoutMs'), `${jobKey} must not expose an unenforced timeout placeholder`);
  assert(!Object.prototype.hasOwnProperty.call(definition, 'concurrencyClass'), `${jobKey} must not expose an unenforced concurrency-class placeholder`);
  assert.strictEqual(registry.defaultIntervalSeconds(jobKey), Number(definition.defaultIntervalSeconds),
    `${jobKey} interval helper must derive from its definition`);
}

assert.deepStrictEqual(new Set(registry.criticalNames()), new Set(criticalJobs.names()),
  'compatibility critical-job facade must derive from the canonical registry metadata');
for (const jobKey of names) {
  assert.strictEqual(criticalJobs.isCritical(jobKey), registry.definition(jobKey).critical,
    `${jobKey} critical classification drifted`);
}

const worker = fs.readFileSync(path.join(__dirname, 'automation-worker.js'), 'utf8');
assert(worker.includes('jobRegistry.criticalNames()'),
  'automation worker must consume the registry critical classification');
assert(worker.includes('jobRegistry.definition(jobKey)?.run'),
  'automation worker startup guard must validate canonical job definitions');

console.log('automation job definition smoke: ok');
