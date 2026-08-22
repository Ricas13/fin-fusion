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
  return ui.statusBadge('Not verified');
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
    verificationRequests: requestsResult.rows
  };
}

function readinessNotice(readiness) {
  if (readiness.overall.kind === 'good') {
    return ui.notice('success', readiness.overall.detail, { title: readiness.overall.label });
  }
  if (readiness.overall.kind === 'bad') {
    return ui.notice('error', readiness.overall.detail, { title: readiness.overall.label });
  }
  return ui.notice('warn', readiness.overall.detail, { title: readiness.overall.label });
}

function metricCard(label, badge, value, detail) {
  return `<div class="card recoveryMetric"><span>${esc(label)}</span><div class="recoveryMetricHead">${badge}<strong>${esc(value)}</strong></div><small>${esc(detail)}</small></div>`;
}

function recoveryRunbook(readiness) {
  const latest = readiness.latestSuccessful;
  const path = recoveryPath(latest);
  const checkCommand = path ? `bash recovery.sh check ${shellQuote(path)}` : 'bash recovery.sh list';
  const drillCommand = path ? `bash recovery.sh drill ${shellQuote(path)}` : 'bash recovery.sh list';
  const restoreCommand = path
    ? `RESTORE_CONFIRM=RESTORE_CAPTAINFIN_DATABASE bash recovery.sh restore ${shellQuote(path)}`
    : 'bash recovery.sh list';
  return `<details class="card recoveryRunbook">
    <summary><span><strong>Host recovery procedure</strong><small>Offline inspection, full recovery drill and destructive restore commands</small></span>${ui.statusBadge('Advanced')}</summary>
    <div class="recoveryRunbookBody">
      ${ui.confirmationPanel({
        tone: 'info',
        title: 'Practice recovery before an emergency',
        body: 'The non-destructive drill restores the selected encrypted backup into a temporary database and proves the expected CAPTAiNFiN schema is present.',
        items: ['Run the offline check first.', 'Run a full recovery drill after meaningful configuration or database changes.', 'Use production restore only when you intentionally want to replace the live database.']
      })}
      <ol class="recoverySteps">
        <li><div><strong>Inspect the encrypted recovery point</strong><span>Authenticates the backup, decrypts it to protected temporary storage and asks pg_restore to parse the archive. PostgreSQL is not modified.</span></div><code>${esc(checkCommand)}</code></li>
        <li><div><strong>Prove it with a full recovery drill</strong><span>Uses the dedicated verifier role to restore into a temporary database, validates the CAPTAiNFiN schema, then deletes the temporary database.</span></div><code>${esc(drillCommand)}</code></li>
        <li class="recoveryDanger"><div><strong>Restore production only when required</strong><span>This stops CAPTAiNFiN application/workers, replaces the live database, reapplies migrations/runtime roles, restarts services and verifies the deployment. A failed recovery leaves application writers stopped.</span></div><code>${esc(restoreCommand)}</code></li>
      </ol>
      <p class="muted recoveryNote">There is intentionally no browser “Restore” button. Destructive database recovery stays on the production host behind an explicit confirmation phrase.</p>
    </div>
  </details>`;
}

async function page(req) {
  await runtimeSettings.ensureLoaded();
  const d = await data();
  const readiness = deriveRecoveryReadiness(d);
  const latest = readiness.latestSuccessful;
  const latestVerified = readiness.latestVerified;
  const nextRun = d.policy.enabled ? dt(d.worker?.next_run_at) : 'Scheduling disabled';
  const latestValue = latest ? dt(latest.completed_at || latest.started_at) : 'No backup yet';
  const latestDetail = latest
    ? `${latest.file_name || 'Encrypted backup'} · ${bytes(latest.size_bytes)}`
    : 'Run a backup to create the first recovery point.';
  const drillValue = latestVerified ? dt(latestVerified.verified_at) : 'No drill yet';
  const drillDetail = latestVerified
    ? `${latestVerified.file_name || 'Recovery point'} passed a full temporary restore.`
    : 'Verify a backup before relying on it for recovery.';

  const verifyAction = latest
    ? `<form method="post" action="/admin/backups/verify">${token(req)}<button class="button secondary" type="submit" ${readiness.verificationInFlight ? 'disabled' : ''}>${readiness.verificationInFlight ? 'Verification queued' : 'Verify latest now'}</button></form>`
    : '';
  const backupActions = `<form method="post" action="/admin/backups/run">${token(req)}<button class="button secondary" type="submit">Run backup now</button></form>${verifyAction}`;

  const history = d.runs.length
    ? `<div class="tableWrap"><table class="dataTable responsiveTable"><caption class="srOnly">Database backup and recovery verification history</caption><thead><tr><th>Created</th><th>Backup</th><th>Size</th><th>Recovery proof</th><th>Checksum</th><th>Issue</th></tr></thead><tbody>${d.runs.map(run => `<tr>
        <td data-label="Created">${esc(dt(run.completed_at || run.started_at))}</td>
        <td data-label="Backup"><div class="recoveryHistoryName"><strong>${esc(run.file_name || '—')}</strong>${ui.statusBadge(String(run.status || 'unknown').replaceAll('_', ' '), runKind(run.status))}</div></td>
        <td data-label="Size">${esc(bytes(run.size_bytes))}</td>
        <td data-label="Recovery proof">${verificationBadge(run)}</td>
        <td data-label="Checksum"><code>${esc((run.checksum_sha256 || '').slice(0, 16) || '—')}</code></td>
        <td data-label="Issue">${esc(run.error || (run.metadata?.lastVerificationOk === false ? run.verification_note : '') || '—')}</td>
      </tr>`).join('')}</tbody></table></div>`
    : ui.emptyState({ title: 'No recovery points yet', body: 'Run a backup now or leave scheduling enabled; the backup worker will create the first encrypted recovery point.', tone: 'warn' });

  const body = `${ui.noticesFromRequest(req)}
    <section class="recoveryHero card">
      <div class="recoveryHeroHead"><div><span class="uiEyebrow">Recovery readiness</span><h2>${esc(readiness.overall.label)}</h2><p>${esc(readiness.overall.detail)}</p></div>${ui.statusBadge(readiness.overall.label, readiness.overall.kind)}</div>
      ${readinessNotice(readiness)}
    </section>

    <section class="recoveryMetrics" aria-label="Backup and recovery status">
      ${metricCard('Scheduled protection', ui.statusBadge(readiness.protection.label, readiness.protection.kind), nextRun, readiness.protection.detail)}
      ${metricCard('Latest recovery point', ui.statusBadge(readiness.recovery.label, readiness.recovery.kind), latestValue, latestDetail)}
      ${metricCard('Last recovery drill', ui.statusBadge(latestVerified ? 'Proven' : 'Not proven', latestVerified ? 'good' : 'warn'), drillValue, drillDetail)}
    </section>

    <section class="card recoveryActions">
      ${ui.sectionHeader({ title: 'Protection policy', description: 'Create encrypted PostgreSQL recovery points automatically and prove them with full temporary restores.', actionsHtml: backupActions })}
      <form class="formPanel recoveryPolicyForm" method="post" action="/admin/backups/policy">
        ${token(req)}
        <div class="toggleGrid">
          <label class="toggleRow"><input type="checkbox" name="enabled" value="1" ${d.policy.enabled ? 'checked' : ''}><span>Enable scheduled backups</span></label>
          <label class="toggleRow"><input type="checkbox" name="verifyAfterBackup" value="1" ${d.policy.verifyAfterBackup ? 'checked' : ''}><span>Prove each new backup with a full temporary restore</span></label>
        </div>
        <div class="formGrid">
          <div class="formGroup"><label for="backupIntervalHours">Backup interval (hours)</label><input class="input" id="backupIntervalHours" type="number" min="1" max="720" name="intervalHours" value="${esc(d.policy.intervalHours)}"></div>
          <div class="formGroup"><label for="backupRetentionDays">Retention (days)</label><input class="input" id="backupRetentionDays" type="number" min="1" max="3650" name="retentionDays" value="${esc(d.policy.retentionDays)}"></div>
          <div class="formGroup"><label for="backupMinimumCopies">Minimum copies to retain</label><input class="input" id="backupMinimumCopies" type="number" min="1" max="365" name="minimumCopies" value="${esc(d.policy.minimumCopies)}"></div>
        </div>
        <div class="buttonRow"><button class="button" type="submit">Save protection policy</button></div>
      </form>
    </section>

    ${recoveryRunbook(readiness)}

    <section class="card recoveryHistory">
      ${ui.sectionHeader({ title: 'Recovery-point history', description: 'Backup creation and full restore verification are separate signals. A green backup is strongest when its recovery proof is also green.' })}
      ${history}
    </section>`;

  return layout({
    siteName: runtimeSettings.siteName(),
    active: 'backups',
    title: 'Backups & recovery',
    subtitle: 'Know whether your latest encrypted recovery point is fresh, proven and recoverable',
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
      const latest = (await query(`SELECT id,file_name FROM backup_runs WHERE status='succeeded' AND file_path IS NOT NULL ORDER BY started_at DESC LIMIT 1`)).rows[0];
      if (!latest) throw new Error('No successful backup is available to verify.');
      let queued = false;
      await transaction(async client => {
        const inserted = await client.query(`INSERT INTO backup_verification_requests(backup_run_id,requested_by) SELECT $1,$2 WHERE NOT EXISTS(SELECT 1 FROM backup_verification_requests WHERE backup_run_id=$1 AND status IN ('queued','running')) RETURNING id`, [latest.id, req.session.authUserId]);
        queued = inserted.rowCount > 0;
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.backup.verify_request','backup_run',$2,$3::jsonb)`, [req.session.authUserId, latest.id, JSON.stringify({ queued, fileName: latest.file_name || null })]);
      });
      const message = queued
        ? `Full restore verification queued for ${latest.file_name || latest.id}.`
        : `Verification of ${latest.file_name || latest.id} is already queued or running.`;
      return res.redirect('/admin/backups?message=' + encodeURIComponent(message));
    } catch (error) {
      return res.redirect('/admin/backups?error=' + encodeURIComponent(error.message));
    }
  });
  return router;
}

module.exports = { createAdminBackupsRouter, data, page, recoveryPath, shellQuote };
