'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const reconciliation = require('../jellyfin/identity-reconciliation');
const stremioOrphans = require('../stremio/orphan-account-cleanup');
const routeRateLimit = require('../security/route-rate-limit');
const { esc, layout } = require('./admin-html');

const identityActionLimit = routeRateLimit.middleware({ scope: 'admin-media-identity-reconciliation', max: 30, windowSeconds: 3600 });

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

function csrfInput(req) {
  return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`;
}

function when(value) {
  if (!value) return 'Never';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' });
}

function label(value) {
  return ({
    stremio_orphan: 'Stremio orphan',
    access_leak: 'Access leak',
    possible_duplicate: 'Possible duplicate',
    unlinked_entitled_customer: 'Entitled but unlinked',
    unlinked_customer: 'Customer match',
    possible_match: 'Weak match',
    ambiguous_match: 'Ambiguous',
    unmatched_orphan: 'Unmatched'
  })[value] || String(value || 'Unknown');
}

function pill(value) {
  if (['access_leak','stremio_orphan'].includes(value)) return 'bad';
  if (['possible_duplicate','ambiguous_match','possible_match'].includes(value)) return 'warn';
  if (value === 'unlinked_entitled_customer') return 'accent';
  return '';
}

function candidateText(row) {
  if (!row.candidates?.length) return '<span class="muted">No customer match</span>';
  return row.candidates.map(candidate => {
    const identity = candidate.portal_email || candidate.customer_email || candidate.portal_username || candidate.display_name || candidate.customer_id;
    return `<div><strong>${esc(identity || candidate.customer_id)}</strong><div class="subText"><code>${esc(candidate.customer_id)}</code> · ${esc(candidate.match || 'match')}</div></div>`;
  }).join('');
}

function accessText(row) {
  const access = row.candidate_access;
  if (!access) return '—';
  return `<div><strong>Primary:</strong> ${esc(access.primary_state || '—')}</div><div class="subText"><strong>Free:</strong> ${esc(access.free_state || '—')}</div>`;
}

function existingText(row) {
  const accounts = Array.isArray(row.existing_accounts) ? row.existing_accounts.filter(item => item.account_purpose === 'jellyfin') : [];
  if (!accounts.length) return '<span class="muted">None</span>';
  return accounts.map(account => `<div><strong>${esc(account.server_name)}</strong>: ${esc(account.jellyfin_username)}<div class="subText">${esc(account.access_lane || 'primary')} · <code>${esc(account.account_id)}</code></div></div>`).join('');
}

function deleteForm(req, row) {
  return `<form method="post" action="/admin/servers/identity-reconciliation/delete" class="formPanel" style="margin-top:8px">
    ${csrfInput(req)}
    <input type="hidden" name="serverId" value="${esc(row.server_id)}">
    <input type="hidden" name="jellyfinUserId" value="${esc(row.jellyfin_user_id)}">
    <input type="hidden" name="expectedName" value="${esc(row.jellyfin_username)}">
    <label class="checkRow"><input type="checkbox" name="confirm" value="1" required><span>Confirm remote deletion</span></label>
    <button class="button secondary btn-sm">Delete remote identity</button>
  </form>`;
}

function actionForms(req, row) {
  const candidate = row.candidates?.length === 1 ? row.candidates[0] : null;
  const normal = (row.existing_accounts || []).filter(account => account.account_purpose === 'jellyfin');
  const sameServer = normal.filter(account => String(account.server_id) === String(row.server_id));
  let forms = '';

  if (candidate && row.classification === 'unlinked_entitled_customer') {
    forms += `<form method="post" action="/admin/servers/identity-reconciliation/link" class="formPanel" style="margin-top:8px">
      ${csrfInput(req)}
      <input type="hidden" name="customerId" value="${esc(candidate.customer_id)}">
      <input type="hidden" name="serverId" value="${esc(row.server_id)}">
      <input type="hidden" name="jellyfinUserId" value="${esc(row.jellyfin_user_id)}">
      <input type="hidden" name="lane" value="primary">
      <button class="button btn-sm">Link existing identity</button>
    </form>`;
  }

  if (candidate && row.classification === 'possible_duplicate' && sameServer.length === 1) {
    forms += `<form method="post" action="/admin/servers/identity-reconciliation/replace" class="formPanel" style="margin-top:8px">
      ${csrfInput(req)}
      <input type="hidden" name="customerId" value="${esc(candidate.customer_id)}">
      <input type="hidden" name="accountId" value="${esc(sameServer[0].account_id)}">
      <input type="hidden" name="serverId" value="${esc(row.server_id)}">
      <input type="hidden" name="jellyfinUserId" value="${esc(row.jellyfin_user_id)}">
      <input type="hidden" name="expectedName" value="${esc(row.jellyfin_username)}">
      <label class="checkRow"><input type="checkbox" name="confirm" value="1" required><span>Make this the canonical identity and retire the currently managed remote user</span></label>
      <button class="button btn-sm">Use this identity instead</button>
    </form>`;
  }

  if (!candidate || ['unmatched_orphan','possible_match','ambiguous_match','unlinked_customer'].includes(row.classification)) {
    forms += `<details style="margin-top:8px"><summary>Link manually to a customer</summary>
      <form method="post" action="/admin/servers/identity-reconciliation/link" class="formPanel" style="margin-top:8px">
        ${csrfInput(req)}
        <input type="hidden" name="serverId" value="${esc(row.server_id)}">
        <input type="hidden" name="jellyfinUserId" value="${esc(row.jellyfin_user_id)}">
        <div class="formGroup"><label>Customer ID</label><input class="input" name="customerId" required placeholder="Customer UUID"></div>
        <input type="hidden" name="lane" value="primary">
        <button class="button btn-sm">Link after safety checks</button>
      </form>
    </details>`;
  }

  forms += deleteForm(req, row);
  return forms;
}

function table(req, result) {
  if (!result.rows.length) return '<div class="empty">No unmanaged media identities were found.</div>';
  return `<div class="tableWrap"><table class="dataTable responsiveTable">
    <thead><tr><th>Remote identity</th><th>Finding</th><th>Candidate customer</th><th>Canonical access</th><th>Existing managed identity</th><th>Action</th></tr></thead>
    <tbody>${result.rows.map(row => `<tr>
      <td><strong>${esc(row.jellyfin_username)}</strong><div class="subText">${esc(row.server_name)} · <code>${esc(row.jellyfin_user_id)}</code></div><div class="subText">Last login: ${esc(when(row.last_login_at))}<br>Last activity: ${esc(when(row.last_activity_at))}</div></td>
      <td><span class="pill ${pill(row.classification)}">${esc(label(row.classification))}</span><div class="subText">${esc(row.candidate_confidence ? `${row.candidate_confidence} match` : '')}</div></td>
      <td>${candidateText(row)}</td>
      <td>${accessText(row)}</td>
      <td>${existingText(row)}</td>
      <td>${actionForms(req, row)}</td>
    </tr>`).join('')}</tbody>
  </table></div>`;
}

function metrics(result, stremio) {
  const total = Number(result.rows.length || 0);
  const leaks = Number(result.counts?.access_leak || 0);
  const duplicates = Number(result.counts?.possible_duplicate || 0);
  const stremioCount = Number(result.counts?.stremio_orphan || 0);
  const safeStremio = stremio.rows.filter(row => row.status === 'orphan_ready').length;
  return `<div class="metrics">
    <div class="metric"><div class="metricLabel">Unmanaged identities</div><div class="metricValue">${esc(total)}</div></div>
    <div class="metric"><div class="metricLabel">Access leaks</div><div class="metricValue">${esc(leaks)}</div></div>
    <div class="metric"><div class="metricLabel">Possible duplicates</div><div class="metricValue">${esc(duplicates)}</div></div>
    <div class="metric"><div class="metricLabel">Stremio orphans</div><div class="metricValue">${esc(stremioCount)}</div><div class="subText">${esc(safeStremio)} safe for automatic cleanup now</div></div>
  </div>`;
}

async function page(req, { message = null, error = null } = {}) {
  await runtimeSettings.ensureLoaded();
  const [result, stremio] = await Promise.all([
    reconciliation.discover(),
    stremioOrphans.inventory()
  ]);
  const failures = [...(result.failures || []), ...(stremio.failures || [])];
  const body = `
    ${message ? `<div class="notice success"><strong>${esc(message)}</strong></div>` : ''}
    ${error ? `<div class="notice error"><strong>${esc(error)}</strong></div>` : ''}
    ${failures.length ? `<div class="notice warn"><strong>Some media servers could not be inspected.</strong> Refresh after the server is reachable. No automatic destructive action is taken against unreadable servers.</div>` : ''}
    ${metrics(result, stremio)}
    <section class="section">
      <div class="sectionHead"><div><h2>Media identity reconciliation</h2><div class="muted">Compare live Jellyfin/Emby identities against CAPTAiNFiN ownership. Nothing is deleted merely because a username looks similar.</div></div><div class="buttonRow"><a class="button secondary btn-sm" href="/admin/jellyfin-import">Import customers</a><a class="button secondary btn-sm" href="/admin/servers">Servers</a></div></div>
      <div class="operatorCallout"><strong>Automatic cleanup is intentionally narrow.</strong> Only orphaned <code>cf_stremio_*</code> service identities are eligible for background deletion, and only when they are not managed, not being provisioned, not administrators, not in an active session and outside the activity grace period. Normal customer identities always require an operator decision.</div>
      ${table(req, result)}
    </section>`;
  return layout({
    siteName: runtimeSettings.siteName(),
    active: 'media-identity-reconciliation',
    title: 'Media identity reconciliation',
    subtitle: 'Find duplicate, orphaned and out-of-band Jellyfin/Emby access',
    body
  });
}

function redirect(res, message) {
  return res.redirect(303, '/admin/servers/identity-reconciliation?message=' + encodeURIComponent(message));
}

function createAdminMediaIdentityReconciliationRouter() {
  const router = express.Router();
  router.use('/admin/servers/identity-reconciliation', gate, noStore);

  router.get('/admin/servers/identity-reconciliation', async (req, res, next) => {
    try {
      return res.send(await page(req, { message: req.query?.message || null }));
    } catch (error) {
      return next(error);
    }
  });

  router.post('/admin/servers/identity-reconciliation/delete', identityActionLimit, async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    if (req.body?.confirm !== '1') return res.status(400).send(await page(req, { error: 'Confirm remote deletion first.' }));
    try {
      const deleted = await reconciliation.deleteRemoteIdentity({
        serverId: req.body?.serverId,
        jellyfinUserId: req.body?.jellyfinUserId,
        expectedName: req.body?.expectedName,
        actorUserId: req.session.authUserId,
        reason: 'Deleted from media identity reconciliation'
      });
      return redirect(res, `Deleted unmanaged remote identity ${deleted.jellyfin_username}.`);
    } catch (error) {
      try { return res.status(400).send(await page(req, { error: error.message || String(error) })); }
      catch (renderError) { return next(renderError); }
    }
  });

  router.post('/admin/servers/identity-reconciliation/link', identityActionLimit, async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const linked = await reconciliation.linkRemoteIdentity({
        customerId: req.body?.customerId,
        serverId: req.body?.serverId,
        jellyfinUserId: req.body?.jellyfinUserId,
        lane: req.body?.lane || 'primary',
        actorUserId: req.session.authUserId
      });
      return redirect(res, `Linked ${linked.user?.jellyfin_username || 'remote identity'} to the customer and reconciled access.`);
    } catch (error) {
      try { return res.status(400).send(await page(req, { error: error.message || String(error) })); }
      catch (renderError) { return next(renderError); }
    }
  });

  router.post('/admin/servers/identity-reconciliation/replace', identityActionLimit, async (req, res, next) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    if (req.body?.confirm !== '1') return res.status(400).send(await page(req, { error: 'Confirm canonical identity replacement first.' }));
    try {
      const result = await reconciliation.replaceManagedIdentity({
        customerId: req.body?.customerId,
        accountId: req.body?.accountId,
        serverId: req.body?.serverId,
        jellyfinUserId: req.body?.jellyfinUserId,
        expectedName: req.body?.expectedName,
        actorUserId: req.session.authUserId
      });
      const warnings = [result.cleanupWarning, result.reconcileWarning].filter(Boolean);
      const message = warnings.length
        ? `Canonical identity changed safely. ${warnings.join(' ')}`
        : 'Canonical media identity changed and the old remote identity was retired.';
      return redirect(res, message);
    } catch (error) {
      try { return res.status(400).send(await page(req, { error: error.message || String(error) })); }
      catch (renderError) { return next(renderError); }
    }
  });

  return router;
}

module.exports = {
  createAdminMediaIdentityReconciliationRouter,
  page,
  table,
  metrics,
  label
};
