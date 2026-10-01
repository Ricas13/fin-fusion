'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registry = require('../src/automation/jobs');

assert(!fs.existsSync(path.join(__dirname, '..', 'src', 'automation', 'job-metadata.js')),
  'retired automation metadata side-table must stay removed');
assert(!fs.existsSync(path.join(__dirname, '..', 'src', 'automation', 'critical-jobs.js')),
  'retired critical-jobs compatibility facade must stay removed');

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

for (const jobKey of names) {
  assert.strictEqual(registry.isCritical(jobKey), registry.definition(jobKey).critical,
    `${jobKey} critical classification drifted`);
  assert.strictEqual(registry.mayBeDisabled(jobKey), Boolean(registry.definition(jobKey).disableableCritical),
    `${jobKey} disableable-critical classification drifted`);
}

const worker = fs.readFileSync(path.join(__dirname, 'automation-worker.js'), 'utf8');
assert(worker.includes('jobRegistry.criticalNames()'),
  'automation worker must consume the registry critical classification');
assert(worker.includes('jobRegistry.definition(jobKey)?.run'),
  'automation worker startup guard must validate canonical job definitions');

console.log('automation job definition smoke: ok');
