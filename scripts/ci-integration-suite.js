'use strict';

const { spawnSync } = require('child_process');
const { Client } = require('pg');

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required for the integration suite');

function run(label, command, args, extraEnv = {}) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'test', ...extraEnv },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${label} failed with exit code ${result.status}`);
  }
}

async function resetDatabase() {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query('DROP SCHEMA IF EXISTS public CASCADE');
    await client.query('CREATE SCHEMA public');
  } finally {
    await client.end();
  }
  run('Apply database migrations', 'npm', ['run', 'db:migrate']);
}

const suites = [
  {
    name: 'Admin analytics dashboard',
    commands: [['node', ['scripts/admin-analytics-dashboard-smoke.js']]],
  },
  {
    name: 'Admin personal notification save',
    commands: [['node', ['scripts/admin-personal-notification-save-smoke.js']]],
  },
  {
    name: 'Adversarial concurrency and referral safety',
    commands: [
      ['node', ['scripts/adversarial-concurrency-smoke.js']],
      ['node', ['scripts/referral-safety-smoke.js']],
    ],
  },
  {
    name: 'Affiliate service credit accounting',
    commands: [
      ['node', ['scripts/affiliate-service-credit-smoke.js']],
      ['node', ['scripts/affiliate-mixed-payment-smoke.js']],
    ],
  },
  {
    name: 'Billing lifecycle',
    commands: [['node', ['scripts/billing-lifecycle-smoke.js']]],
  },
  {
    name: 'Browser payment configuration and flexible checkout',
    commands: [['node', ['scripts/browser-payments-flex-smoke.js']]],
  },
  {
    name: 'Checkout commercial contract',
    commands: [['node', ['scripts/checkout-contract-smoke.js']]],
  },
  {
    name: 'Configuration transfer',
    commands: [['node', ['scripts/configuration-transfer-smoke.js']]],
  },
  {
    name: 'Customer claim and account tokens',
    commands: [
      ['node', ['scripts/customer-claim-smoke.js']],
      ['node', ['scripts/account-token-atomicity-smoke.js']],
    ],
  },
  {
    name: 'Fleet-aware placement',
    env: { PLACEMENT_FLEET_METRICS_STALE_SECONDS: '300' },
    commands: [['node', ['scripts/fleet-aware-placement-smoke.js']]],
  },
  {
    name: 'Fleet live metrics',
    commands: [['node', ['scripts/fleet-live-metrics-smoke.js']]],
  },
  {
    name: 'Free Server lifecycle end to end',
    commands: [['node', ['scripts/free-server-lifecycle-smoke.js']]],
  },
  {
    name: 'Jellyfin user import',
    commands: [['node', ['scripts/jellyfin-user-import-smoke.js']]],
  },
  {
    name: 'Plan creation commerce',
    commands: [
      ['node', ['scripts/plan-create-v2-smoke.js']],
      ['node', ['scripts/plan-create-commerce-smoke.js']],
    ],
  },
  {
    name: 'Platform database coherence',
    commands: [
      ['node', ['scripts/platform-coherence-db-smoke.js']],
      ['node', ['scripts/jellyfin-drift-smoke.js']],
    ],
  },
  {
    name: 'Provisioning control database contract',
    commands: [['node', ['scripts/provisioning-control-db-smoke.js']]],
  },
  {
    name: 'Request service settings',
    commands: [['node', ['scripts/request-service-settings-smoke.js']]],
  },
  {
    name: 'Request user synchronization',
    commands: [['node', ['scripts/request-user-sync-smoke.js']]],
  },
  {
    name: 'Server migration and rollback',
    commands: [['node', ['scripts/server-migration-smoke.js']]],
  },
  {
    name: 'Transactional email',
    commands: [['node', ['scripts/transactional-email-smoke.js']]],
  },
];

(async () => {
  for (const suite of suites) {
    console.log(`\n################ ${suite.name} ################`);
    await resetDatabase();
    for (const [command, args] of suite.commands) {
      run(suite.name, command, args, suite.env || {});
    }
  }
  console.log(`\nIntegration suite complete: ${suites.length} isolated database groups passed.`);
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});