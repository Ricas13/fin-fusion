'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const { layout, esc } = require('./admin-html');
const ui = require('./admin-ui');
const runtimeSettings = require('./runtime-settings');
const releaseStatus = require('./release-status');

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

function page(req, status) {
  const version = `v${status.version}`;
  const compareAction = status.compareUrl
    ? `<a class="button secondary" href="${esc(status.compareUrl)}" target="_blank" rel="noopener noreferrer">Review changes</a>`
    : '';
  const body = `${ui.noticesFromRequest(req)}
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
  return layout({ siteName: runtimeSettings.siteName(), active: 'system', title: 'System', subtitle: 'Version, build identity and production update status', body });
}

function createAdminSystemRouter() {
  const router = express.Router();
  router.use('/admin/system', gate, noStore);
  router.get('/admin/system', async (req, res, next) => {
    try {
      await runtimeSettings.ensureLoaded();
      const status = releaseStatus.publicStatus(await releaseStatus.checkForUpdate());
      return res.send(page(req, status));
    } catch (error) { return next(error); }
  });
  router.get('/admin/system/status.json', async (_req, res, next) => {
    try {
      const status = releaseStatus.publicStatus(await releaseStatus.checkForUpdate());
      return res.json(status);
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

module.exports = { createAdminSystemRouter, page, kindFor };
