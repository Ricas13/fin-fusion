'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const registry = require('../src/automation/jobs');

const worker = fs.readFileSync(path.join(__dirname, 'automation-worker.js'), 'utf8');

for (const [jobKey, expected] of Object.entries({
  free_capacity_backfill: 30,
  free_places_digest: 30,
  creation_intent_recovery: 60,
  customer_service_recovery: 60,
  revenue_integrity: 60,
  provider_financial_reconciliation: 300,
  paypal_history_reconciliation: 300,
  provider_checkout_recovery: 300,
  subscription_discovery: 21600,
  data_retention: 3600,
  discord_roles: 43200,
  stremio_external_tokens: 300,
  stremio_media_index: 300
})) {
  assert.strictEqual(registry.defaultIntervalSeconds(jobKey), expected, `${jobKey} default interval drifted`);
}
assert.strictEqual(registry.defaultIntervalSeconds('email_outbox'), 300,
  'jobs without an explicit override must keep the safe 300-second default');
assert(worker.includes('jobRegistry.defaultIntervalSeconds(jobKey)'),
  'automation worker must read default intervals from the canonical job registry');
assert(!worker.includes('DEFAULT_JOB_INTERVALS'),
  'automation worker must not maintain a second interval table');

console.log('automation job registry smoke: ok');
