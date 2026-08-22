'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const { layout, esc } = require('./admin-html');
const ui = require('./admin-ui');
const { deriveRecoveryReadiness } = require('./backup-recovery-readiness');

function gate(req, res, next) {
  return req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId
    ? next()
    : res.redirect('/login?session=expired');
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
function bytes(value) {
  const n = Number(value || 0);
  if (!n) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let current = n;
  let unit = 0;
  while (current >= 1024 && unit < units.length - 1) {
    current /= 1024;
    unit += 1;
  }
  return `${current.toFixed(unit ? 1 : 0)} ${units[unit]}`;
}
function boolEnv(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}
function token(req) {
  return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}
function recoveryPath(run) {
  const filePath = String(run?.file_path || '');
  if (filePath.startsWith('/backups/')) return `backups/${filePath.slice('/backups/'.length)}`;
  return run?.file_name ? `backups/${run.file_name}` : '';
}
function shellQuote(value) {
  return `'${String(value || '').replaceAll("'", `'\"'\"'`)}'`;
}
function runKind(status) {
  if (status === 'succeeded') return 'good';
  if (status === 'failed') return 'bad';
  if (status === 'deleted') return '';
  return 'warn';
}
function verificationBadge(run) {
  if (run.verified_at) return `${ui.statusBadge('Verified', 'good')}<div class="subText">${esc(dt(run.verified_at))}</div>`;
  const lastOk = run.metadata?.lastVerificationOk;
  if (lastOk === false) return `${ui.statusBadge('Failed', 'bad')}<div class="subText">${esc(run.verification_note || 'Restore verification failed.')}</div>`;
  return ui.statusBadge('Not verified', 'warn');
}
function offsiteBadge(run) {
  const copy = run?.metadata?.offsite || {};
  if (copy.state === 'succeeded') return `${ui.statusBadge('Copied off-host', 'good')}<div class="subText">${esc(dt(copy.copiedAt))}</div>`;
  if (copy.state === 'failed') return `${ui.statusBadge('Copy failed', 'bad')}<div class="subText">${esc(copy.error || 'Encrypted off-host copy failed.')}</div>`;
  if (copy.state === 'copying') return ui.statusBadge('Copying', 'warn');
  return ui.statusBadge('Local only', 'warn');
}

async function data() {
  const [policyResult, workerResult, runsResult, requestsResult] = await Promise.all([
    query(`SELECT setting_value FROM platform_settings WHERE setting_key='backup_policy_v1'`),
    query(`SELECT *, EXTRACT(EPOCH FROM (NOW()-last_heartbeat_at))::int heartbeat_age_seconds FROM backup_worker_state WHERE worker_key='database_backup'`),
    query(`SELECT * FROM backup_runs ORDER BY started_at DESC LIMIT 100`),
    query(`SELECT v.id,v.backup_run_id,v.status,v.requested_at,v.started_at,v.completed_at,v.error,b.file_name
           FROM backup_verification_requests v
           LEFT JOIN backup_runs b ON b.id=v.backup_run_id
           ORDER BY v.requested_at DESC LIMIT 50`)
  ]);
  const value = policyResult.rows[0]?.setting_value || {};
  return {
    policy: {
      enabled: value.enabled !== false,
      intervalHours: Number(value.intervalHours) || 24,
      retentionDays: Number(value.retentionDays) || 30,
      minimumCopies: Number(value.minimumCopies) || 7,
      verifyAfterBackup: value.verifyAfterBackup !== false
    },
    worker: workerResult.rows[0] || null,
    runs: runsResult.rows,
    verificationRequests: requestsResult.rows,
    offsiteEnabled: boolEnv(process.env.BACKUP_OFFSITE_ENABLED),
    offsiteProvider: String(process.env.BACKUP_OFFSITE_PROVIDER || 's3').slice(0, 20)
  };
}

function metricCard(label, badge, value, detail) {
  return `<div class="card recoveryMetric"><span>${esc(label)}</span><div class="recoveryMetricHead">${badge}<strong>${esc(value)}</strong></div><small>${esc(detail)}</small></div>`;
}

function verifyForm(req, run, { label = 'Verify recovery point', primary = true, disabled = false } = {}) {
  if (!run) return '';
  return `<form method="post" action="/admin/backups/verify">${token(req)}<input type="hidden" name="runId" value="${esc(run.id)}"><button class="button ${primary ? '' : 'secondary'}" type="submit" ${disabled ? 'disabled' : ''}>${esc(disabled ? 'Verification queued' : label)}</button></form>`;
}

function recoveryRunbook(readiness) {
  const latest = readiness.latestSuccessful;
  const path = recoveryPath(latest);
  const checkCommand = path ? `bash recovery.sh check ${shellQuote(path)}` : 'bash recovery.sh list';
  const drillCommand = path ? `bash recovery.sh drill ${shellQuote(path)}` : 'bash recovery.sh list';
  const restoreCommand = path
    ? `RESTORE_CONFIRM=RESTORE_CAPTAINFIN_DATABASE bash recovery.sh restore ${shellQuote(path)}`
    : 'bash recovery.sh list';
  const fetchCommand = 'docker compose --profile recovery run --rm --no-deps recovery-tools node scripts/offsite-backup.js list';
  return `<details class="card recoveryRunbook operatorDetails">
    <summary><span>Host recovery procedure</span><small>Advanced · command-line recovery only</small></summary>
    <div class="recoveryRunbookBody operatorDetailsBody">
      ${ui.confirmationPanel({
        tone: 'info',
        title: 'Practice recovery before an emergency',
        body: 'The non-destructive drill restores the selected encrypted backup into a temporary database and proves the expected CAPTAiNFiN schema is present.',
        items: ['Keep BACKUP_ENCRYPTION_KEY in a separate protected secrets system.', 'Run a full recovery drill after meaningful configuration or database changes.', 'Use production restore only when you intentionally want to replace the live database.']
      })}
      <ol class="recoverySteps">
        <li><div><strong>Recover an off-host copy after host loss</strong><span>List the encrypted remote recovery points, download the chosen object into ./backups, then continue with the same offline check and restore flow.</span></div><code>${esc(fetchCommand)}</code></li>
        <li><div><strong>Inspect the encrypted recovery point</strong><span>Authenticates the backup, decrypts it to protected temporary storage and asks pg_restore to parse the archive. PostgreSQL is not modified.</span></div><code>${esc(checkCommand)}</code></li>
        <li><div><strong>Prove it with a full recovery drill</strong><span>Uses the dedicated verifier role to restore into a temporary database, validates the CAPTAiNFiN schema, then deletes the temporary database.</span></div><code>${esc(drillCommand)}</code></li>
        <li class="recoveryDanger"><div><strong>Restore production only when required</strong><span>This stops CAPTAiNFiN application/workers, replaces the live database, reapplies migrations/runtime roles, restarts services and verifies the deployment. A failed recovery leaves application writers stopped.</span></div><code>${esc(restoreCommand)}</code></li>
      </ol>
      <p class="muted recoveryNote">There is intentionally no browser “Restore” button. Destructive database recovery stays on the production host behind an explicit confirmation phrase.</p>
    </div>
  </details>`;
}

function historyTable(runs) {
  if (!runs.length) return '';
  return `<div class="tableWrap"><table class="dataTable responsiveTable"><caption class="srOnly">Database backup and recovery verification history</caption><thead><tr><th>Created</th><th>Backup</th><th>Size</th><th>Recovery proof</th><th>Off-host</th><th>Checksum</th><th>Issue</th></tr></thead><tbody>${runs.map(run => `<tr id="backup-${esc(run.id)}">
      <td data-label="Created">${esc(dt(run.completed_at || run.started_at))}</td>
      <td data-label="Backup"><div class="recoveryHistoryName"><strong>${esc(run.file_name || '—')}</strong>${ui.statusBadge(String(run.status || 'unknown').replaceAll('_', ' '), runKind(run.status))}</div></td>
      <td data-label="Size">${esc(bytes(run.size_bytes))}</td>
      <td data-label="Recovery proof">${verificationBadge(run)}</td>
      <td data-label="Off-host">${offsiteBadge(run)}</td>
      <td data-label="Checksum"><code>${esc((run.checksum_sha256 || '').slice(0, 16) || '—')}</code></td>
      <td data-label="Issue">${esc(run.error || run.metadata?.offsite?.error || (run.metadata?.lastVerificationOk === false ? run.verification_note : '') || '—')}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function selectedResolution(req, d, readiness) {
  const requestedId = String(req.query.run || '').trim();
  const run = requestedId ? d.runs.find(entry => String(entry.id) === requestedId) : null;
  if (!run) return '';
  if (run.status === 'failed') {
    return ui.resolutionCard({
      tone: 'bad', badge: 'You came here to fix this', title: 'This backup failed',
      body: `${run.file_name || 'The selected backup'} did not create a usable recovery point.`,
      reason: run.error || 'The backup worker reported a failure.',
      actionHtml: `<form method="post" action="/admin/backups/run">${token(req)}<button class="button" type="submit">Create a new backup now</button></form>`,
      secondaryHtml: '<a class="button secondary" href="/admin/backups">Dismiss context</a>'
    });
  }
  if (run.verified_at) {
    return ui.resolutionCard({
      tone: 'good', badge: 'Already resolved', title: 'This recovery point is proven',
      body: `${run.file_name || 'The selected backup'} passed a full temporary restore on ${dt(run.verified_at)}.`,
      actionHtml: '<a class="button secondary" href="/admin/backups">Back to recovery overview</a>'
    });
  }
  const inFlight = d.verificationRequests.some(request => String(request.backup_run_id) === String(run.id) && ['queued', 'running'].includes(request.status));
  return ui.resolutionCard({
    tone: 'warn', badge: 'You came here to fix this', title: 'Prove this recovery point before relying on it',
    body: `${run.file_name || 'The selected backup'} exists, but CAPTAiNFiN has not yet proven that it can be restored successfully.`,
    reason: 'Backup creation and recovery verification are separate safety signals.',
    actionHtml: verifyForm(req, run, { label: 'Verify this backup now', primary: true, disabled: inFlight }),
    secondaryHtml: '<a class="button secondary" href="/admin/backups">Dismiss context</a>'
  });
}

async function page(req) {
  await runtimeSettings.ensureLoaded();
  const d = await data();
  const readiness = deriveRecoveryReadiness(d);
  const latest = readiness.latestSuccessful;
  const latestVerified = readiness.latestVerified;
  const nextRun = d.policy.enabled ? dt(d.worker?.next_run_at) : 'Scheduling disabled';
  const latestValue = latest ? dt(latest.completed_at || latest.started_at) : 'No backup yet';
  const latestDetail = latest ? `${latest.file_name || 'Encrypted backup'} · ${bytes(latest.size_bytes)}` : 'Run a backup to create the first recovery point.';
  const drillValue = latestVerified ? dt(latestVerified.verified_at) : 'No drill yet';
  const drillDetail = latestVerified ? `${latestVerified.file_name || 'Recovery point'} passed a full temporary restore.` : 'Verify a backup before relying on it for recovery.';
  const offsiteValue = readiness.offsite?.state === 'copied'
    ? dt(latest?.metadata?.offsite?.copiedAt)
    : readiness.offsite?.state === 'off'
      ? 'Not configured'
      : readiness.offsite?.label || 'Unknown';
  const latestInFlight = latest && d.verificationRequests.some(request => String(request.backup_run_id) === String(latest.id) && ['queued', 'running'].includes(request.status));
  const runBackup = `<form method="post" action="/admin/backups/run">${token(req)}<button class="button secondary" type="submit">Create backup now</button></form>`;
  const verifyLatest = latest ? verifyForm(req, latest, { label: 'Verify latest backup', primary: readiness.overall.kind !== 'good', disabled: latestInFlight }) : '';
  const nextAction = !latest
    ? 'Create the first encrypted backup.'
    : !latest.verified_at
      ? 'Verify the latest recovery point with a full temporary restore.'
      : readiness.offsite?.kind !== 'good'
        ? readiness.offsite?.detail || 'Configure encrypted off-host copies for host-loss recovery.'
        : readiness.overall.kind === 'good'
          ? 'No action required. Local and host-loss recovery protection are healthy.'
          : readiness.overall.detail;
  const heroTone = readiness.overall.kind === 'good' ? 'good' : readiness.overall.kind === 'bad' ? 'bad' : 'warn';
  const recentRuns = d.runs.slice(0, 8);
  const recentHistory = recentRuns.length ? historyTable(recentRuns) : ui.emptyState({ title: 'No recovery points yet', body: 'Create a backup now or leave scheduling enabled; the worker will create the first encrypted recovery point.', tone: 'warn' });

  const policyForm = `<form class="formPanel recoveryPolicyForm" method="post" action="/admin/backups/policy">
      ${token(req)}
      <div class="toggleGrid">
        <label class="toggleRow"><input type="checkbox" name="enabled" value="1" ${d.policy.enabled ? 'checked' : ''}><span>Enable scheduled backups</span></label>
        <label class="toggleRow"><input type="checkbox" name="verifyAfterBackup" value="1" ${d.policy.verifyAfterBackup ? 'checked' : ''}><span>Automatically verify each new backup</span></label>
      </div>
      <div class="formGrid">
        <div class="formGroup"><label for="backupIntervalHours">Backup every</label><div class="inputUnit"><input class="input" id="backupIntervalHours" type="number" min="1" max="720" name="intervalHours" value="${esc(d.policy.intervalHours)}"><span>hours</span></div></div>
        <div class="formGroup"><label for="backupRetentionDays">Keep backups for</label><div class="inputUnit"><input class="input" id="backupRetentionDays" type="number" min="1" max="3650" name="retentionDays" value="${esc(d.policy.retentionDays)}"><span>days</span></div></div>
        <div class="formGroup"><label for="backupMinimumCopies">Always keep at least</label><div class="inputUnit"><input class="input" id="backupMinimumCopies" type="number" min="1" max="365" name="minimumCopies" value="${esc(d.policy.minimumCopies)}"><span>copies</span></div></div>
      </div>
      <div class="buttonRow"><button class="button" type="submit">Save protection schedule</button></div>
    </form>`;

  const body = `${ui.noticesFromRequest(req)}
    ${selectedResolution(req, d, readiness)}
    ${ui.operatorHero({
      tone: heroTone,
      eyebrow: 'Recovery protection',
      title: readiness.overall.label,
      body: readiness.overall.detail,
      statusLabel: readiness.overall.kind === 'good' ? 'Protected' : readiness.overall.kind === 'bad' ? 'Action required' : 'Needs proof',
      next: nextAction,
      facts: [
        { label: 'Next scheduled backup', value: nextRun, detail: readiness.protection.label },
        { label: 'Latest recovery point', value: latestValue, detail: latestDetail },
        { label: 'Last proven restore', value: drillValue, detail: drillDetail },
        { label: 'Latest off-host copy', value: offsiteValue, detail: readiness.offsite?.label || 'Off-host status unavailable' }
      ],
      actionsHtml: `${verifyLatest}${runBackup}`
    })}

    <section class="recoveryMetrics" aria-label="Backup and recovery status">
      ${metricCard('Scheduled protection', ui.statusBadge(readiness.protection.label, readiness.protection.kind), nextRun, readiness.protection.detail)}
      ${metricCard('Latest recovery point', ui.statusBadge(readiness.recovery.label, readiness.recovery.kind), latestValue, latestDetail)}
      ${metricCard('Recovery proof', ui.statusBadge(latest?.verified_at ? 'Proven' : 'Not proven', latest?.verified_at ? 'good' : 'warn'), latest?.verified_at ? dt(latest.verified_at) : 'Verification needed', latest?.verified_at ? 'The latest recovery point passed a full temporary restore.' : 'Use Verify latest backup to prove it safely.')}
      ${metricCard('Host-loss copy', ui.statusBadge(readiness.offsite?.label || 'Unknown', readiness.offsite?.kind || 'warn'), offsiteValue, readiness.offsite?.detail || 'Configure encrypted off-host protection on the production host.')}
    </section>

    ${ui.detailDisclosure({ title: 'Protection schedule & retention', summary: 'Routine settings · normally leave these alone', bodyHtml: policyForm })}

    <section class="card recoveryHistory">
      ${ui.sectionHeader({ title: 'Recent recovery points', description: 'The newest eight are shown here so local failures, verification gaps and off-host copy failures are easy to spot.' })}
      ${recentHistory}
      ${d.runs.length > 8 ? ui.detailDisclosure({ title: `Full backup history (${d.runs.length})`, summary: 'Detailed audit history', bodyHtml: historyTable(d.runs) }) : ''}
    </section>

    ${recoveryRunbook(readiness)}`;

  return layout({
    siteName: runtimeSettings.siteName(),
    active: 'backups',
    title: 'Backups & recovery',
    subtitle: 'See whether local and host-loss recovery are safe, what needs doing next, and only open detailed history when you need it',
    body
  });
}

function createAdminBackupsRouter() {
  const router = express.Router();
  router.use('/admin/backups', gate, noStore);
  router.get('/admin/backups', async (req, res, next) => {
    try { return res.send(await page(req)); }
    catch (error) { return next(error); }
  });
  router.post('/admin/backups/policy', async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const value = {
        enabled: req.body.enabled === '1',
        intervalHours: Math.max(1, Math.min(720, Number(req.body.intervalHours) || 24)),
        retentionDays: Math.max(1, Math.min(3650, Number(req.body.retentionDays) || 30)),
        minimumCopies: Math.max(1, Math.min(365, Number(req.body.minimumCopies) || 7)),
        verifyAfterBackup: req.body.verifyAfterBackup === '1'
      };
      await transaction(async client => {
        await client.query(`INSERT INTO platform_settings(setting_key,setting_value) VALUES('backup_policy_v1',$1::jsonb) ON CONFLICT(setting_key) DO UPDATE SET setting_value=EXCLUDED.setting_value,updated_at=NOW()`, [JSON.stringify(value)]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.backup.policy','platform_setting','backup_policy_v1',$2::jsonb)`, [req.session.authUserId, JSON.stringify(value)]);
        if (value.enabled) await client.query(`UPDATE backup_worker_state SET next_run_at=LEAST(COALESCE(next_run_at,NOW()),NOW()),updated_at=NOW() WHERE worker_key='database_backup'`);
      });
      return res.redirect('/admin/backups?message=' + encodeURIComponent('Backup protection policy saved.'));
    } catch (error) {
      return res.redirect('/admin/backups?error=' + encodeURIComponent(error.message));
    }
  });
  router.post('/admin/backups/run', async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const result = await query(`UPDATE backup_worker_state SET next_run_at=NOW(),updated_at=NOW() WHERE worker_key='database_backup' RETURNING worker_key`);
      if (!result.rowCount) throw new Error('Backup worker has not registered yet.');
      return res.redirect('/admin/backups?message=' + encodeURIComponent('Backup queued for the next worker poll.'));
    } catch (error) {
      return res.redirect('/admin/backups?error=' + encodeURIComponent(error.message));
    }
  });
  router.post('/admin/backups/verify', async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const requestedId = String(req.body.runId || '').trim();
      const target = requestedId
        ? (await query(`SELECT id,file_name FROM backup_runs WHERE id=$1 AND status='succeeded' AND file_path IS NOT NULL LIMIT 1`, [requestedId])).rows[0]
        : (await query(`SELECT id,file_name FROM backup_runs WHERE status='succeeded' AND file_path IS NOT NULL ORDER BY started_at DESC LIMIT 1`)).rows[0];
      if (!target) throw new Error(requestedId ? 'That recovery point is not available for verification.' : 'No successful backup is available to verify.');
      let queued = false;
      await transaction(async client => {
        const inserted = await client.query(`INSERT INTO backup_verification_requests(backup_run_id,requested_by) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM backup_verification_requests WHERE backup_run_id=$1 AND status IN ('queued','running')) RETURNING id`, [target.id, req.session.authUserId]);
        queued = inserted.rowCount > 0;
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.backup.verify_request','backup_run',$2,$3::jsonb)`, [req.session.authUserId, target.id, JSON.stringify({ queued, fileName: target.file_name || null })]);
      });
      const message = queued
        ? `Full restore verification queued for ${target.file_name || target.id}.`
        : `Verification of ${target.file_name || target.id} is already queued or running.`;
      const context = requestedId ? `&run=${encodeURIComponent(target.id)}` : '';
      return res.redirect('/admin/backups?message=' + encodeURIComponent(message) + context);
    } catch (error) {
      return res.redirect('/admin/backups?error=' + encodeURIComponent(error.message));
    }
  });
  return router;
}

module.exports = { createAdminBackupsRouter, data, page, recoveryPath, shellQuote, verifyForm, historyTable, selectedResolution, offsiteBadge };
