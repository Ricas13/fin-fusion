'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { layout, esc } = require('./admin-html');
const ui = require('./admin-ui');
const runtimeSettings = require('./runtime-settings');
const releaseStatus = require('./release-status');
const diagnostics = require('./system-diagnostics');
const operationalMetrics = require('./operational-metrics');

function gate(req, res, next) {
  if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
  return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}
function dt(value) {
  if (!value) return '—';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '—' : parsed.toLocaleString('en-GB');
}
function kindFor(state) {
  if (state === 'current') return 'good';
  if (state === 'update_available' || state === 'custom_build' || state === 'unknown_build' || state === 'unavailable') return 'warn';
  return '';
}
function token(req) {
  return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}
function statusNotice(status) {
  if (status.state === 'update_available') return ui.notice('warn', 'A newer commit is available on main. Review the changes below before updating the production host.', { title: 'Update available' });
  if (status.state === 'current') return ui.notice('success', 'This deployed build matches the latest commit on main.', { title: 'Up to date' });
  if (status.state === 'custom_build') return ui.notice('warn', 'This build does not sit behind the current main branch. It may be newer, pinned, or from a custom branch; review the source checkout before updating.', { title: 'Custom build detected' });
  if (status.state === 'unknown_build') return ui.notice('warn', 'The application version is known, but this image does not contain an exact build commit. Deploy through bash install.sh or bash update.sh to embed build metadata.', { title: 'Exact build unknown' });
  if (status.state === 'disabled') return ui.notice('warn', 'Automatic update checking is disabled for this process. The running version remains available below.', { title: 'Update checks disabled' });
  return ui.notice('warn', `CAPTAiNFiN could not verify main right now${status.error ? `: ${status.error}` : '.'}`, { title: 'Update check unavailable' });
}
function systemHealthNotice(system) {
  if (system.overall.kind === 'good') return ui.notice('success', system.overall.detail, { title: system.overall.label });
  if (system.overall.kind === 'bad') return ui.notice('error', system.overall.detail, { title: system.overall.label });
  return ui.notice('warn', system.overall.detail, { title: system.overall.label });
}
function healthCard(group) {
  return `<a class="card systemHealthCard systemHealth-${esc(group.kind)}" href="${esc(group.href)}"><div class="systemHealthCardHead"><strong>${esc(group.label)}</strong>${ui.statusBadge(group.kind === 'good' ? 'Healthy' : group.kind === 'bad' ? 'Attention' : 'Review', group.kind)}</div><p>${esc(group.detail)}</p><span class="systemHealthOpen">Review →</span></a>`;
}
function metricCard(label, value, detail, kind = '') {
  return `<div class="card systemReleaseMetric"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(detail)}</small>${kind ? `<span class="pill ${esc(kind)}">${esc(kind === 'good' ? 'Healthy' : kind === 'bad' ? 'Attention' : 'Review')}</span>` : ''}</div>`;
}
function operationalSection(system) {
  const operational = system.operational || {};
  const pool = operational.databasePool || {};
  const reconcile = operational.reconciliation || {};
  const backlog = operational.backlog || {};
  const poolKind = pool.unavailable ? 'warn' : Number(pool.waiting || 0) > 0 ? 'warn' : 'good';
  const reconcileKind = reconcile.unavailable ? 'warn' : Number(reconcile.failed || 0) || Number(reconcile.lockTimeouts || 0) ? 'warn' : 'good';
  const backlogTotal = Number(backlog.paymentEventRetries || 0) + Number(backlog.providerRecovery || 0) + Number(backlog.providerManualReview || 0) + Number(backlog.freeDowngradeRetries || 0) + Number(backlog.provisioningProblems || 0);
  const backlogKind = backlog.available === false ? 'warn' : backlogTotal > 0 ? 'warn' : 'good';
  const backlogWarning = backlog.warning ? `<div class="systemSafetyNote"><strong>Metric collection degraded</strong><p>${esc(backlog.warning)}</p></div>` : '';
  return `<section class="card systemReleaseActions systemOperationalMetrics">
    ${ui.sectionHeader({ title: 'Operational pressure', description: 'Live process-local reconciliation pressure and durable recovery backlogs. These are canonical counters and queue rows, not sampled logs.' })}
    <section class="systemReleaseGrid" aria-label="Operational pressure metrics">
      ${metricCard('Database pool', `${Number(pool.total || 0)}/${Number(pool.max || 0) || '—'}`, `${Number(pool.idle || 0)} idle · ${Number(pool.waiting || 0)} waiting`, poolKind)}
      ${metricCard('Reconciliation', `${Number(reconcile.active || 0)} active · ${Number(reconcile.queued || 0)} queued`, `limit ${Number(reconcile.limit || 0)} · ${Number(reconcile.failed || 0)} failed · ${Number(reconcile.lockTimeouts || 0)} lock timeout(s)`, reconcileKind)}
      ${metricCard('Reconcile timing', `${Number(reconcile.averageDurationMs || 0)} ms avg`, `slot ${Number(reconcile.averageSlotWaitMs || 0)} ms · DB lock ${Number(reconcile.averageDbLockWaitMs || 0)} ms avg`, reconcileKind)}
      ${metricCard('Recovery backlog', `${backlogTotal} item(s)`, `${Number(backlog.paymentEventRetries || 0)} payment · ${Number(backlog.providerRecovery || 0)} provider · ${Number(backlog.freeDowngradeRetries || 0)} Free downgrade`, backlogKind)}
    </section>
    <dl class="systemBuildDetails"><div><dt>Provider manual review</dt><dd>${Number(backlog.providerManualReview || 0)}</dd></div><div><dt>Free downgrade due now</dt><dd>${Number(backlog.freeDowngradeDue || 0)}</dd></div><div><dt>Provisioning blocked/failed</dt><dd>${Number(backlog.provisioningProblems || 0)}</dd></div><div><dt>Provisioning running</dt><dd>${Number(backlog.provisioningRunning || 0)}</dd></div></dl>
    ${backlogWarning}
  </section>`;
}

function page(req, system) {
  const status = system.release;
  const version = `v${status.version}`;
  const compareAction = status.compareUrl
    ? `<a class="button secondary" href="${esc(status.compareUrl)}" target="_blank" rel="noopener noreferrer">Review changes</a>`
    : '';
  const body = `${ui.noticesFromRequest(req)}
    <section class="systemHealthHero card">
      <div class="systemReleaseLead"><div><span class="uiEyebrow">System health</span><h2>${esc(system.overall.label)}</h2><p class="muted">A read-only view of application readiness, workers, backups, fleet and operational configuration.</p></div>${ui.statusBadge(system.overall.label, system.overall.kind)}</div>
      ${systemHealthNotice(system)}
    </section>
    <section class="systemHealthGrid" aria-label="System health checks">
      ${system.groups.map(healthCard).join('')}
    </section>
    ${operationalSection(system)}
    <section class="card systemReleaseActions systemSupportReport">
      ${ui.sectionHeader({ title: 'Support report', description: 'Download an allowlisted diagnostic snapshot for troubleshooting. It contains health states, versions and counts—not environment dumps, credentials, customer data, server URLs or raw operational errors.', actionsHtml: '<a class="button secondary" href="/admin/system/support-report.json" download>Download support report</a>' })}
      <div class="systemSafetyNote"><strong>Review before sharing</strong><p>The report is generated through a deny-on-leak sanitizer and is designed to be shareable with support. Still review any diagnostic file before sending it outside your organisation.</p></div>
      <dl class="systemSupportContents"><div><dt>Included</dt><dd>Build/version, runtime platform, readiness states, worker heartbeat ages, backup readiness, fleet counts, notification counts and sanitized operational pressure counters.</dd></div><div><dt>Excluded</dt><dd>Secrets, tokens, database URLs, email/IP addresses, customer records, plan/server names, provider identifiers and raw logs.</dd></div></dl>
    </section>
    <section class="systemReleaseHero card">
      <div class="systemReleaseLead"><div><span class="uiEyebrow">Running release</span><h2>${esc(version)}</h2><p class="muted">Exact build and upstream status for this CAPTAiNFiN instance.</p></div>${ui.statusBadge(status.label, kindFor(status.state))}</div>
      ${statusNotice(status)}
    </section>
    <section class="systemReleaseGrid" aria-label="Version details">
      <div class="card systemReleaseMetric"><span>Application version</span><strong>${esc(version)}</strong><small>From package metadata</small></div>
      <div class="card systemReleaseMetric"><span>Deployed build</span><strong><code>${esc(status.buildShort || 'Unknown')}</code></strong><small>${esc(status.builtAt ? `Built ${dt(status.builtAt)}` : 'Exact commit metadata unavailable')}</small></div>
      <div class="card systemReleaseMetric"><span>Latest main</span><strong><code>${esc(status.upstreamShort || 'Unknown')}</code></strong><small>${esc(status.upstreamAt ? `Committed ${dt(status.upstreamAt)}` : 'Not verified yet')}</small></div>
      <div class="card systemReleaseMetric"><span>Last checked</span><strong>${esc(dt(status.checkedAt))}</strong><small>Checks are cached to avoid unnecessary GitHub requests</small></div>
    </section>
    <section class="card systemReleaseActions">
      ${ui.sectionHeader({title:'Updates',description:'Updates remain a host operation so the web process never pulls source code or executes deployment commands.',actionsHtml:`${compareAction}<form method="post" action="/admin/system/check">${token(req)}<button class="button secondary" type="submit">Check again</button></form>`})}
      <div class="systemUpdateCommand"><div><strong>Supported update command</strong><small>Run this from the production checkout on the host.</small></div><code>bash update.sh</code></div>
      <div class="systemSafetyNote"><strong>Why there is no “Update now” web button</strong><p>CAPTAiNFiN deliberately keeps source updates, encrypted pre-deploy backups, migrations and container replacement inside the SSH-safe deployment path. The admin UI reports status; it does not gain host command execution privileges.</p></div>
    </section>
    <section class="card systemReleaseActions">
      ${ui.sectionHeader({title:'Build identity',description:'Useful when checking logs, support reports or whether a deployment actually reached the expected revision.'})}
      <dl class="systemBuildDetails"><div><dt>Version</dt><dd>${esc(status.version)}</dd></div><div><dt>Build commit</dt><dd><code>${esc(status.buildSha || 'Unavailable')}</code></dd></div><div><dt>Build time</dt><dd>${esc(dt(status.builtAt))}</dd></div><div><dt>Upstream commit</dt><dd><code>${esc(status.upstreamSha || 'Unavailable')}</code></dd></div></dl>
    </section>`;
  return layout({ siteName: runtimeSettings.siteName(), active: 'system', title: 'System', subtitle: 'Health, diagnostics, build identity and production update status', body });
}

function supportFilename(now = new Date()) {
  return `captainfin-support-${now.toISOString().replace(/[-:]/g, '').replace(/\..+/, '').replace('T', '-')}.json`;
}

async function systemWithOperationalMetrics() {
  const [system, operational] = await Promise.all([
    diagnostics.collectSystemDiagnostics(),
    operationalMetrics.collect()
  ]);
  return { ...system, operational };
}

function createAdminSystemRouter() {
  const router = express.Router();
  router.use('/admin/system', gate, noStore);
  router.get('/admin/system', async (req, res, next) => {
    try {
      await runtimeSettings.ensureLoaded();
      return res.send(page(req, await systemWithOperationalMetrics()));
    } catch (error) { return next(error); }
  });
  router.get('/admin/system/status.json', async (_req, res, next) => {
    try {
      const status = releaseStatus.publicStatus(await releaseStatus.checkForUpdate());
      return res.json(status);
    } catch (error) { return next(error); }
  });
  router.get('/admin/system/support-report.json', async (_req, res, next) => {
    try {
      const system = await systemWithOperationalMetrics();
      const report = {
        ...diagnostics.supportReportFromDiagnostics(system),
        operational: operationalMetrics.supportSnapshot(system.operational)
      };
      diagnostics.assertSanitizedReport(report);
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${supportFilename()}"`);
      res.setHeader('X-Content-Type-Options', 'nosniff');
      return res.send(JSON.stringify(report, null, 2) + '\n');
    } catch (error) { return next(error); }
  });
  router.post('/admin/system/check', async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    const status = releaseStatus.publicStatus(await releaseStatus.checkForUpdate({ force: true }));
    const message = status.state === 'update_available'
      ? 'Update check complete: a newer main build is available.'
      : status.state === 'current'
        ? 'Update check complete: this build matches main.'
        : `Update check complete: ${status.label}.`;
    return res.redirect('/admin/system?message=' + encodeURIComponent(message));
  });
  return router;
}

module.exports = { createAdminSystemRouter, page, kindFor, supportFilename, operationalSection, systemWithOperationalMetrics };
