'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  aggregateIssues,
  supportReportFromDiagnostics,
  assertSanitizedReport
} = require('../src/platform/system-diagnostics');
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
  workers: [{ key: 'automation', heartbeatAgeSeconds: 10, hasError: false }],
  backups: {
    scheduleEnabled: true, workerFresh: true, latestAgeHours: 1.5, latestFresh: true,
    protection: { state: 'healthy' }, recovery: { state: 'verified' }
  },
  fleet: { total: 3, offline: 0, nonActive: 1 },
  notifications: { pending: 2, dead: 0 }
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

const adminSource = fs.readFileSync(path.join(root, 'src/platform/admin-system.js'), 'utf8');
assert(adminSource.includes('System health'));
assert(adminSource.includes('Support report'));
assert(adminSource.includes('/admin/system/support-report.json'));
assert(adminSource.includes('Content-Disposition'));
assert(adminSource.includes("X-Content-Type-Options"));
assert(adminSource.includes('Review before sharing'));
assert(adminSource.includes('Running release'), 'existing version/update section must remain');
assert(!adminSource.includes("require('child_process')"), 'System page must not gain shell execution');
assert(!adminSource.includes('docker.sock'), 'System page must not gain Docker socket access');
assert(!adminSource.includes("readFileSync('.env')"), 'System page must not read .env');

const diagnosticsSource = fs.readFileSync(path.join(root, 'src/platform/system-diagnostics.js'), 'utf8');
assert(diagnosticsSource.includes('supportReportFromDiagnostics'));
assert(diagnosticsSource.includes('assertSanitizedReport(report)'));
assert(diagnosticsSource.includes('SECRET_ENV_KEYS'));
assert(diagnosticsSource.includes("FROM operational_worker_state ORDER BY worker_key"), 'system diagnostics must read process liveness from the canonical worker heartbeat table');
assert(!diagnosticsSource.includes('last_error IS NOT NULL AS has_error'), 'operational_worker_state has no last_error column; job failures belong to automation job state/configuration health');
assert(diagnosticsSource.includes('hasError: false'), 'support report worker compatibility field must not invent a process error signal');
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
