'use strict';

const os = require('os');
const { query, getPool } = require('../db');
const platformHealth = require('./health');
const configurationHealth = require('./admin-configuration-health');
const releaseStatus = require('./release-status');
const runtimeSettings = require('./runtime-settings');
const workerInstanceHealth = require('./worker-instance-health');
const { deriveRecoveryReadiness } = require('./backup-recovery-readiness');

const SECRET_ENV_KEYS = [
  'DATABASE_URL','APP_DATABASE_URL','AUTOMATION_DATABASE_URL','ACTIVITY_DATABASE_URL','BACKUP_DATABASE_URL','BACKUP_VERIFY_DATABASE_URL',
  'POSTGRES_PASSWORD','SESSION_SECRET','DATA_ENCRYPTION_KEY','JELLYFIN_ENCRYPTION_KEY','AUTH_ENCRYPTION_KEY','ACTIVITY_ENCRYPTION_KEY',
  'BACKUP_ENCRYPTION_KEY','BACKUP_S3_ACCESS_KEY_ID','BACKUP_S3_SECRET_ACCESS_KEY','BACKUP_S3_SESSION_TOKEN','STREMIO_JELLYFIN_TOKEN_KEY',
  'JELLYFIN_API_KEY','STRIPE_RESTRICTED_KEY','STRIPE_API_KEY','STRIPE_WEBHOOK_SECRET','PAYPAL_CLIENT_SECRET','PAYPAL_WEBHOOK_ID',
  'TELEGRAM_BOT_TOKEN','SMTP_URL','SEERR_API_KEY','OVERSEERR_API_KEY'
];

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}
function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
function roundMb(bytes) { return Math.round(safeNumber(bytes) / 1024 / 1024); }
function worse(a, b) {
  const rank = { good: 0, warn: 1, bad: 2 };
  return (rank[b] || 0) > (rank[a] || 0) ? b : a;
}
function aggregateIssues(issues = []) {
  const result = { critical: 0, warning: 0, info: 0, total: 0, byArea: {} };
  for (const issue of issues) {
    const severity = ['critical','warning','info'].includes(issue?.severity) ? issue.severity : 'info';
    const area = String(issue?.area || 'Other').slice(0, 60);
    result[severity] += 1;
    result.total += 1;
    if (!result.byArea[area]) result.byArea[area] = { critical: 0, warning: 0, info: 0, total: 0 };
    result.byArea[area][severity] += 1;
    result.byArea[area].total += 1;
  }
  return result;
}
function groupStatus({ key, label, href, critical = 0, warning = 0, detail = '' }) {
  const kind = critical > 0 ? 'bad' : warning > 0 ? 'warn' : 'good';
  return { key, label, href, kind, critical, warning, detail };
}

function workerFreshnessSeconds(row) {
  return workerInstanceHealth.freshnessSeconds(row);
}

function operationalWorkerState(row) {
  return workerInstanceHealth.instanceState(row);
}

async function backupSnapshot() {
  const [policyResult, workerResult, runsResult, requestResult] = await Promise.all([
    query(`SELECT setting_value FROM platform_settings WHERE setting_key='backup_policy_v1'`),
    query(`SELECT *,EXTRACT(EPOCH FROM(NOW()-last_heartbeat_at))::int heartbeat_age_seconds FROM backup_worker_state WHERE worker_key='database_backup'`),
    query(`SELECT id,status,started_at,completed_at,verified_at,checksum_sha256,metadata FROM backup_runs ORDER BY started_at DESC LIMIT 25`),
    query(`SELECT backup_run_id,status,requested_at,error FROM backup_verification_requests ORDER BY requested_at DESC LIMIT 25`)
  ]);
  const value = policyResult.rows[0]?.setting_value || {};
  const policy = {
    enabled: value.enabled !== false,
    intervalHours: Number(value.intervalHours) || 24,
    retentionDays: Number(value.retentionDays) || 30,
    minimumCopies: Number(value.minimumCopies) || 7,
    verifyAfterBackup: value.verifyAfterBackup !== false
  };
  return deriveRecoveryReadiness({
    policy,
    worker: workerResult.rows[0] || null,
    runs: runsResult.rows,
    verificationRequests: requestResult.rows,
    offsiteEnabled: boolEnv(process.env.BACKUP_OFFSITE_ENABLED),
    offsiteProvider: String(process.env.BACKUP_OFFSITE_PROVIDER || 's3').slice(0, 20)
  });
}

async function collectSystemDiagnostics() {
  const generatedAt = new Date().toISOString();
  const [readyResult, configurationResult, releaseResult, dbResult, workersResult, fleetResult, notificationResult, backupResult, runtimeResult] = await Promise.allSettled([
    platformHealth.readiness(),
    configurationHealth.health(),
    releaseStatus.checkForUpdate(),
    query(`SELECT current_setting('server_version') AS version,(SELECT COUNT(*)::int FROM schema_migrations) AS migration_count,(SELECT filename FROM schema_migrations ORDER BY filename DESC LIMIT 1) AS latest_migration`),
    query(`SELECT worker_key,instance_id,version,commit_sha,started_at,last_heartbeat_at,metadata,draining_at,EXTRACT(EPOCH FROM(NOW()-last_heartbeat_at))::int heartbeat_age_seconds FROM operational_worker_state ORDER BY worker_key,last_heartbeat_at DESC`),
    query(`SELECT COUNT(*)::int total,COUNT(*) FILTER(WHERE health_status='offline')::int offline,COUNT(*) FILTER(WHERE COALESCE(placement_mode,'active')<>'active')::int non_active FROM jellyfin_servers WHERE enabled=TRUE`),
    query(`SELECT
      COUNT(*) FILTER(WHERE status='pending')::int pending,
      COUNT(*) FILTER(WHERE status='failed')::int retrying,
      COUNT(*) FILTER(WHERE status='sending')::int sending,
      COUNT(*) FILTER(WHERE status='dead')::int dead,
      COALESCE(EXTRACT(EPOCH FROM(NOW()-MIN(created_at) FILTER(WHERE status IN('pending','failed','sending'))))::int,0) oldest_queued_age_seconds,
      COUNT(*) FILTER(WHERE status='sent' AND sent_at>=NOW()-INTERVAL '24 hours')::int sent_24h,
      COUNT(*) FILTER(WHERE status IN('failed','dead') AND updated_at>=NOW()-INTERVAL '24 hours')::int failed_24h
      FROM notification_outbox`),
    backupSnapshot(),
    runtimeSettings.ensureLoaded()
  ]);

  const readiness = readyResult.status === 'fulfilled' ? readyResult.value : { ok: false, degraded: false, checks: {} };
  const config = configurationResult.status === 'fulfilled' ? configurationResult.value : { issues: [], workers: [], jobs: [], servers: [] };
  const issueSummary = aggregateIssues(config.issues);
  const build = releaseStatus.buildMetadata();
  const release = releaseResult.status === 'fulfilled' ? releaseStatus.publicStatus(releaseResult.value) : {
    state: 'unavailable', label: 'Check unavailable', version: build.version,
    buildSha: build.sha || null, buildShort: build.sha ? build.sha.slice(0, 8) : null, builtAt: build.builtAt || null
  };
  const db = dbResult.status === 'fulfilled' ? dbResult.value.rows[0] || {} : {};
  const workerRows = workersResult.status === 'fulfilled' ? workersResult.value.rows : [];
  const workerHealth = workerInstanceHealth.summarize(workerRows);
  const fleet = fleetResult.status === 'fulfilled' ? fleetResult.value.rows[0] || {} : {};
  const notifications = notificationResult.status === 'fulfilled' ? notificationResult.value.rows[0] || {} : {};
  const backup = backupResult.status === 'fulfilled' ? backupResult.value : null;
  const canonicalRuntimeLoaded = runtimeResult.status === 'fulfilled';
  const securityPosture = {
    production: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
    secureCookies: String(process.env.COOKIE_SECURE || 'true').toLowerCase() !== 'false',
    admin2faRequired: canonicalRuntimeLoaded ? runtimeSettings.requireAdminTwoFactor() : boolEnv(process.env.REQUIRE_ADMIN_2FA),
    publicRegistration: canonicalRuntimeLoaded ? runtimeSettings.publicRegistrationOpen() : boolEnv(process.env.PUBLIC_REGISTRATION)
  };
  const pool = (() => { try { const value = getPool(); return { total: value.totalCount, idle: value.idleCount, waiting: value.waitingCount }; } catch { return { total: 0, idle: 0, waiting: 0 }; } })();

  const countsFor = areas => areas.reduce((acc, area) => {
    const value = issueSummary.byArea[area] || {};
    acc.critical += value.critical || 0;
    acc.warning += value.warning || 0;
    return acc;
  }, { critical: 0, warning: 0 });
  const planCounts = countsFor(['Plan']);
  const automationCounts = countsFor(['Automation']);
  const integrationCounts = countsFor(['Payments','Requests']);
  const fleetCounts = countsFor(['Fleet']);
  const notificationCounts = countsFor(['Notifications']);
  const databaseKind = readiness.checks?.database && readiness.checks?.migrations ? 'good' : 'bad';
  const applicationKind = readiness.ok ? (readiness.degraded ? 'warn' : 'good') : 'bad';
  const backupKind = backup?.overall?.kind || 'bad';
  const workerStates = workerHealth.workers.map(row => ({ row, state: row.state }));
  const hardWorkerProblems = workerStates.filter(item => ['stale','failed'].includes(item.state)).length;
  const softWorkerProblems = workerStates.filter(item => ['degraded','draining','maintenance'].includes(item.state)).length;
  const workerInstanceWarnings = workerHealth.warnings.filter(warning => ['duplicate_instances','version_skew'].includes(warning.type)).length;
  const expectedWorkers = new Set(['automation','activity']);
  for (const row of workerHealth.workers) expectedWorkers.delete(String(row.key || ''));
  const missingWorkers = expectedWorkers.size;
  const queuedAge = safeNumber(notifications.oldest_queued_age_seconds);
  const notificationStuck = queuedAge > 15 * 60;

  const groups = [
    { key: 'application', label: 'Application', href: '/admin/system', kind: applicationKind, detail: readiness.ok ? (readiness.degraded ? 'Running with a capability warning.' : 'Process readiness checks passed.') : 'One or more process readiness checks failed.' },
    { key: 'database', label: 'Database', href: '/admin/system', kind: databaseKind, detail: databaseKind === 'good' ? 'Database connectivity and migrations are current.' : 'Database connectivity or migration state needs attention.' },
    groupStatus({ key: 'catalogue', label: 'Catalogue & plans', href: '/admin/plans', critical: planCounts.critical, warning: planCounts.warning, detail: planCounts.critical || planCounts.warning ? 'One or more active plan readiness checks need review.' : 'No active plan readiness issues detected.' }),
    groupStatus({ key: 'automation', label: 'Background workers', href: '/admin/automation', critical: automationCounts.critical + hardWorkerProblems, warning: automationCounts.warning + softWorkerProblems + missingWorkers + workerInstanceWarnings, detail: workerInstanceWarnings ? `${workerInstanceWarnings} duplicate/version-skew worker warning(s) detected.` : hardWorkerProblems ? `${hardWorkerProblems} worker heartbeat/outcome problem(s) detected.` : softWorkerProblems || missingWorkers ? `${softWorkerProblems} degraded/draining and ${missingWorkers} missing expected worker state(s).` : 'Automation and Activity worker heartbeats are within their own expected cadence.' }),
    { key: 'backups', label: 'Backups & recovery', href: '/admin/backups', kind: backupKind, critical: backupKind === 'bad' ? 1 : 0, warning: backupKind === 'warn' ? 1 : 0, detail: backup?.overall?.detail || 'Backup readiness could not be determined.' },
    groupStatus({ key: 'fleet', label: 'Jellyfin fleet', href: '/admin/servers', critical: fleetCounts.critical, warning: fleetCounts.warning + safeNumber(fleet.offline), detail: `${safeNumber(fleet.total)} enabled server(s); ${safeNumber(fleet.offline)} offline; ${safeNumber(fleet.non_active)} not accepting normal placement.` }),
    groupStatus({ key: 'integrations', label: 'Payments & integrations', href: '/admin/payments', critical: integrationCounts.critical, warning: integrationCounts.warning, detail: integrationCounts.critical || integrationCounts.warning ? 'Configuration health found integration items requiring review.' : 'No payment/request configuration issues detected.' }),
    groupStatus({ key: 'notifications', label: 'Notifications', href: '/admin/notifications/preferences', critical: notificationCounts.critical, warning: notificationCounts.warning + (safeNumber(notifications.dead) ? 1 : 0) + (notificationStuck ? 1 : 0), detail: notificationStuck ? `Oldest queued notification is ${Math.ceil(queuedAge / 60)} minutes old; ${safeNumber(notifications.dead)} dead-letter item(s).` : `${safeNumber(notifications.pending)} pending, ${safeNumber(notifications.retrying)} retrying; ${safeNumber(notifications.dead)} dead-letter notification(s).` })
  ];
  let overallKind = groups.reduce((kind, group) => worse(kind, group.kind), 'good');
  if (issueSummary.critical) overallKind = 'bad';
  else if (issueSummary.warning) overallKind = worse(overallKind, 'warn');

  return {
    generatedAt,
    overall: {
      kind: overallKind,
      label: overallKind === 'good' ? 'System healthy' : overallKind === 'warn' ? 'System needs review' : 'System needs attention',
      detail: `${issueSummary.critical} critical, ${issueSummary.warning} warning and ${issueSummary.info} informational configuration issue(s).`
    },
    groups,
    release,
    readiness,
    issueSummary,
    database: {
      connected: Boolean(readiness.checks?.database),
      migrationsCurrent: Boolean(readiness.checks?.migrations),
      serverVersion: String(db.version || 'unknown').slice(0, 40),
      migrationCount: safeNumber(db.migration_count),
      latestMigration: db.latest_migration ? String(db.latest_migration).slice(0, 120) : null,
      pool
    },
    workers: workerHealth.workers,
    workerInstances: workerHealth.instances,
    workerWarnings: workerHealth.warnings,
    backups: backup,
    fleet: { total: safeNumber(fleet.total), offline: safeNumber(fleet.offline), nonActive: safeNumber(fleet.non_active) },
    notifications: {
      pending: safeNumber(notifications.pending),
      retrying: safeNumber(notifications.retrying),
      sending: safeNumber(notifications.sending),
      dead: safeNumber(notifications.dead),
      oldestQueuedAgeSeconds: queuedAge,
      sent24h: safeNumber(notifications.sent_24h),
      failed24h: safeNumber(notifications.failed_24h),
      stuck: notificationStuck
    },
    securityPosture
  };
}

function supportReportFromDiagnostics(diagnostics) {
  const memory = process.memoryUsage();
  const areaCounts = Object.entries(diagnostics.issueSummary.byArea).map(([area, counts]) => ({ area, critical: counts.critical, warning: counts.warning, info: counts.info, total: counts.total }));
  const report = {
    schemaVersion: 1,
    generatedAt: diagnostics.generatedAt,
    application: {
      version: diagnostics.release.version,
      buildSha: diagnostics.release.buildSha,
      builtAt: diagnostics.release.builtAt,
      updateState: diagnostics.release.state,
      nodeVersion: process.version,
      uptimeSeconds: Math.round(process.uptime()),
      environment: String(process.env.NODE_ENV || 'unknown').slice(0, 20)
    },
    platform: {
      os: os.platform(),
      release: os.release(),
      architecture: os.arch(),
      cpuCount: os.cpus().length,
      processMemoryMb: { rss: roundMb(memory.rss), heapUsed: roundMb(memory.heapUsed) }
    },
    health: {
      overall: diagnostics.overall.kind,
      groups: diagnostics.groups.map(group => ({ key: group.key, state: group.kind })),
      issueCounts: {
        critical: diagnostics.issueSummary.critical,
        warning: diagnostics.issueSummary.warning,
        info: diagnostics.issueSummary.info,
        areas: areaCounts
      }
    },
    database: diagnostics.database,
    workers: diagnostics.workers,
    backups: diagnostics.backups ? {
      scheduled: diagnostics.backups.scheduleEnabled,
      workerFresh: diagnostics.backups.workerFresh,
      protectionState: diagnostics.backups.protection.state,
      recoveryState: diagnostics.backups.recovery.state,
      offsiteState: diagnostics.backups.offsite?.state || 'unknown',
      latestAgeHours: diagnostics.backups.latestAgeHours == null ? null : Math.round(diagnostics.backups.latestAgeHours * 10) / 10,
      latestFresh: diagnostics.backups.latestFresh
    } : { scheduled: false, workerFresh: false, protectionState: 'unknown', recoveryState: 'unknown', offsiteState: 'unknown', latestAgeHours: null, latestFresh: false },
    fleet: diagnostics.fleet,
    notifications: diagnostics.notifications,
    securityPosture: diagnostics.securityPosture || {
      production: String(process.env.NODE_ENV || '').toLowerCase() === 'production',
      secureCookies: String(process.env.COOKIE_SECURE || 'true').toLowerCase() !== 'false',
      admin2faRequired: boolEnv(process.env.REQUIRE_ADMIN_2FA),
      publicRegistration: boolEnv(process.env.PUBLIC_REGISTRATION)
    }
  };
  assertSanitizedReport(report);
  return report;
}

function assertSanitizedReport(report, env = process.env) {
  const serialized = JSON.stringify(report);
  const forbiddenKey = /password|secret|credential|databaseurl|api[_-]?key|webhook|access[_-]?token|refresh[_-]?token|email|ipaddress/i;
  const email = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;
  const ipv4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;
  const credentialPrefix = /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9_-]+|\bwhsec_[A-Za-z0-9_-]+|postgres(?:ql)?:\/\//i;
  const visit = value => {
    if (Array.isArray(value)) return value.forEach(visit);
    if (!value || typeof value !== 'object') {
      if (typeof value === 'string' && (email.test(value) || ipv4.test(value) || credentialPrefix.test(value))) throw new Error('Support report sanitizer rejected sensitive-looking content.');
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKey.test(key)) throw new Error(`Support report sanitizer rejected field: ${key}`);
      visit(child);
    }
  };
  visit(report);
  for (const key of SECRET_ENV_KEYS) {
    const value = String(env[key] || '');
    if (value.length >= 6 && serialized.includes(value)) throw new Error(`Support report sanitizer detected configured secret: ${key}`);
  }
  return true;
}

module.exports = {
  collectSystemDiagnostics,
  supportReportFromDiagnostics,
  assertSanitizedReport,
  aggregateIssues,
  groupStatus,
  workerFreshnessSeconds,
  operationalWorkerState,
  SECRET_ENV_KEYS
};