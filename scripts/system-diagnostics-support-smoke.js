'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  aggregateIssues,
  supportReportFromDiagnostics,
  assertSanitizedReport
} = require('../src/platform/system-diagnostics');
const operationalMetrics = require('../src/platform/operational-metrics');
const { supportFilename } = require('../src/platform/admin-system');

const root = path.join(__dirname, '..');
const issues = aggregateIssues([
  { severity: 'critical', area: 'Payments' },
  { severity: 'warning', area: 'Payments' },
  { severity: 'warning', area: 'Fleet' },
  { severity: 'info', area: 'Plan' }
]);
assert.strictEqual(issues.critical, 1);
assert.strictEqual(issues.warning, 2);
assert.strictEqual(issues.byArea.Payments.total, 2);

const fixture = {
  generatedAt: '2026-08-22T06:00:00.000Z',
  overall: { kind: 'warn', label: 'System needs review', detail: 'fixture' },
  groups: [
    { key: 'application', kind: 'good' },
    { key: 'database', kind: 'good' },
    { key: 'backups', kind: 'warn' }
  ],
  release: {
    version: '1.4.0', buildSha: '0123456789abcdef0123456789abcdef01234567', builtAt: '2026-08-22T05:00:00.000Z', state: 'current'
  },
  issueSummary: issues,
  database: { connected: true, migrationsCurrent: true, serverVersion: '17.5', migrationCount: 20, latestMigration: '020_fixture.sql', pool: { total: 3, idle: 2, waiting: 0 } },
  workers: [{ key: 'automation', heartbeatAgeSeconds: 10, freshnessSeconds: 90, state: 'healthy', lastCycleOutcome: null, serverFailures: 0 }],
  backups: {
    scheduleEnabled: true, workerFresh: true, latestAgeHours: 1.5, latestFresh: true,
    protection: { state: 'healthy' }, recovery: { state: 'verified' }
  },
  fleet: { total: 3, offline: 0, nonActive: 1 },
  notifications: { pending: 2, retrying: 0, sending: 0, dead: 0, oldestQueuedAgeSeconds: 10, sent24h: 3, failed24h: 0, stuck: false },
  securityPosture: { production: true, secureCookies: true, admin2faRequired: true, publicRegistration: false }
};

const previous = {
  DATABASE_URL: process.env.DATABASE_URL,
  STRIPE_API_KEY: process.env.STRIPE_API_KEY,
  SESSION_SECRET: process.env.SESSION_SECRET
};
process.env.DATABASE_URL = 'postgresql://support_user:super-secret-password@db.internal/captainfin';
process.env.STRIPE_API_KEY = 'sk_live_fixture_secret_value';
process.env.SESSION_SECRET = 'fixture-session-secret-value';
try {
  const report = supportReportFromDiagnostics(fixture);
  const json = JSON.stringify(report);
  assert.strictEqual(report.schemaVersion, 1);
  assert.strictEqual(report.health.issueCounts.critical, 1);
  assert.strictEqual(report.securityPosture.admin2faRequired, true);
  assert.strictEqual(report.securityPosture.publicRegistration, false);
  assert(!json.includes('super-secret-password'));
  assert(!json.includes('sk_live_fixture_secret_value'));
  assert(!json.includes('fixture-session-secret-value'));
  assert(!json.includes('postgresql://'));
  assert(!json.includes('customer@example.com'));
  assert(!json.includes('192.168.1.20'));
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

assert.throws(() => assertSanitizedReport({ password: 'anything' }, {}), /rejected field/i);
assert.throws(() => assertSanitizedReport({ contact: 'customer@example.com' }, {}), /sensitive-looking/i);
assert.throws(() => assertSanitizedReport({ address: '192.168.1.20' }, {}), /sensitive-looking/i);
assert.throws(() => assertSanitizedReport({ provider: 'sk_live_fixture_123456789' }, {}), /sensitive-looking/i);
assert.throws(() => assertSanitizedReport({ database: 'postgresql://u:p@db/x' }, {}), /sensitive-looking/i);
assert.throws(() => assertSanitizedReport({ harmless: 'known-secret-value' }, { SESSION_SECRET: 'known-secret-value' }), /configured secret/i);
assert.match(supportFilename(new Date('2026-08-22T06:07:08.000Z')), /^captainfin-support-20260822-060708\.json$/);

const operational = operationalMetrics.supportSnapshot({
  databasePool: { total: 7, idle: 3, waiting: 2, max: 10 },
  reconciliation: {
    active: 2, queued: 4, limit: 4, total: 100, succeeded: 91, failed: 7, lockTimeouts: 2, canceled: 0,
    averageDurationMs: 140, averageSlotWaitMs: 20, averageDbLockWaitMs: 8, maxDurationMs: 900, maxSlotWaitMs: 120, maxDbLockWaitMs: 80
  },
  backlog: {
    paymentEventRetries: 3, providerRecovery: 2, providerManualReview: 1, freeDowngradeRetries: 4,
    freeDowngradeDue: 2, provisioningProblems: 5, provisioningRunning: 1, available: true
  }
});
assert.deepStrictEqual(operational.databasePool, { total: 7, idle: 3, waiting: 2, max: 10, unavailable: false });
assert.strictEqual(operational.reconciliation.queued, 4);
assert.strictEqual(operational.reconciliation.averageDbLockWaitMs, 8);
assert.strictEqual(operational.backlog.freeDowngradeDue, 2);
assert.strictEqual(operational.backlog.providerManualReview, 1);
assertSanitizedReport({ operational }, {});

const adminSource = fs.readFileSync(path.join(root, 'src/platform/admin-system.js'), 'utf8');
assert(adminSource.includes('System health'));
assert(adminSource.includes('Support report'));
assert(adminSource.includes('/admin/system/support-report.json'));
assert(adminSource.includes('Content-Disposition'));
assert(adminSource.includes("X-Content-Type-Options"));
assert(adminSource.includes('Review before sharing'));
assert(adminSource.includes('Running release'), 'existing version/update section must remain');
assert(adminSource.includes('Operational pressure'), 'System page must surface runtime reconciliation/queue pressure');
assert(adminSource.includes('systemWithOperationalMetrics()'), 'System page and support report must consume the same operational metric snapshot');
assert(adminSource.includes('operationalMetrics.supportSnapshot(system.operational)'), 'support report must include only the sanitized operational counter projection');
assert(!adminSource.includes("require('child_process')"), 'System page must not gain shell execution');
assert(!adminSource.includes('docker.sock'), 'System page must not gain Docker socket access');
assert(!adminSource.includes("readFileSync('.env')"), 'System page must not read .env');

const metricsSource = fs.readFileSync(path.join(root, 'src/platform/operational-metrics.js'), 'utf8');
assert(metricsSource.includes("reconciliationLock.concurrencySnapshot()"), 'reconciliation pressure must come from the canonical lock/gate owner');
assert(metricsSource.includes('pool.totalCount') && metricsSource.includes('pool.waitingCount') && metricsSource.includes('pool.options?.max'), 'DB pool pressure must come from the live pg pool');
assert(metricsSource.includes('processed_at IS NULL AND processing_error IS NOT NULL'), 'payment retry backlog must use durable payment event retry truth');
assert(metricsSource.includes("manual_review_required=TRUE"), 'provider manual-review backlog must be explicit');
assert(metricsSource.includes('automatic_free_downgrade_retries'), 'automatic Free downgrade retries must be surfaced');
assert(metricsSource.includes("status IN ('blocked','failed')"), 'provisioning problem backlog must use canonical customer provisioning state');
assert(metricsSource.includes("console.warn('Operational backlog diagnostics unavailable.'"), 'best-effort backlog failures must be visible rather than silently swallowed');
assert(metricsSource.includes("warning: 'Operational backlog metrics are temporarily unavailable.'"), 'operators must see degraded metric collection in the System page');
assert(!metricsSource.includes('customer_id AS') && !metricsSource.includes('SELECT customer_id,'), 'operational counters must not expose customer identities');

const diagnosticsSource = fs.readFileSync(path.join(root, 'src/platform/system-diagnostics.js'), 'utf8');
assert(diagnosticsSource.includes('supportReportFromDiagnostics'));
assert(diagnosticsSource.includes('assertSanitizedReport(report)'));
assert(diagnosticsSource.includes('SECRET_ENV_KEYS'));
assert(diagnosticsSource.includes("FROM operational_worker_state ORDER BY worker_key"), 'system diagnostics must read process liveness from the canonical worker heartbeat table');
assert(!diagnosticsSource.includes('last_error IS NOT NULL AS has_error'), 'operational_worker_state has no last_error column; process outcome belongs to sanitized heartbeat metadata');
assert(diagnosticsSource.includes('operationalWorkerState(row)'), 'support report workers must expose cadence-aware process state');
assert(!diagnosticsSource.includes('Object.entries(process.env)'), 'support report must not enumerate the environment');
assert(!diagnosticsSource.includes('customer_id'), 'support report collector must not query customer identities');
assert(!diagnosticsSource.includes('email_address'), 'support report collector must not query customer emails');
assert(!diagnosticsSource.includes('base_url'), 'support report collector must not query server URLs');
assert(!diagnosticsSource.includes('api_key'), 'support report collector must not query API keys');

const docs = fs.readFileSync(path.join(root, 'docs/SUPPORT_DIAGNOSTICS.md'), 'utf8');
assert(docs.includes('Settings → System'));
assert(docs.includes('review the file before sharing'));
assert(docs.includes('does not include'));

console.log('system diagnostics support smoke: ok');
