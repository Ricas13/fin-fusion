'use strict';

const express = require('express');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const runtimeSettings = require('./runtime-settings');
const requestUsers = require('../integrations/request-user-sync');
const requestServiceSettings = require('../integrations/request-service-settings');
const { layout, esc } = require('./admin-html');

const writeLimit = routeRateLimit.middleware({ scope: 'admin-request-users-write', max: 60, windowSeconds: 60, reason: 'admin_request_users_write' });

function gate(req, res, next) {
  if (req.session?.authUserId && req.session?.authRole === 'admin' && req.session?.adminId) return next();
  return res.redirect('/login?session=expired');
}
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, private, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  next();
}
function csrfInput(req) { return `<input type="hidden" name="_csrf" value="${esc(csrf.token(req))}">`; }
function checked(value) { return value === 'on' || value === '1' || value === true; }
function dt(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function pill(status) {
  const value = status || 'pending';
  const kind = value === 'synced' ? 'good' : value === 'failed' ? 'bad' : value === 'skipped' ? 'warn' : '';
  return `<span class="pill ${kind}">${esc(value[0].toUpperCase() + value.slice(1))}</span>`;
}
function notice(req) {
  return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function quota(limit, days) { return limit == null || Number(limit) === 0 ? 'Unlimited' : `${Number(limit)} / ${Number(days) || 30}d`; }
function syncSummaryMessage(prefix, result) {
  const ignored = result.ignored ? `, ${result.ignored} awaiting an external account` : '';
  return `${prefix}: ${result.created} created, ${result.linked} active/linked, ${result.suspended} suspended, ${result.failed} failed${ignored}.`;
}

function configPanel(req, status) {
  const source = status.source === 'database' ? 'Browser-managed' : status.source === 'environment-migration' ? 'Environment key + migrated URL' : 'Environment fallback';
  const readiness = !status.enabled ? '<span class="pill warn">Disabled</span>' : status.configured ? '<span class="pill good">Ready</span>' : '<span class="pill bad">Incomplete</span>';
  const open = status.baseUrl ? `<a class="button secondary" href="${esc(status.baseUrl)}" target="_blank" rel="noopener noreferrer">Open request site</a>` : '';
  const testDisabled = !(status.baseUrl && status.apiKeyConfigured);
  return `<section class="section"><div class="sectionHead"><div><h2>Central request service</h2><div class="muted">One Overseerr / Jellyseerr / Seerr instance for customers spread across all Jellyfin servers.</div></div>${readiness}</div><form class="formPanel" method="post" action="/admin/request-users/settings">${csrfInput(req)}<label class="toggleRow"><input type="checkbox" name="enabled" ${status.enabled ? 'checked' : ''}><span><strong>Enable central request integration</strong><small class="muted">When disabled, automatic user sync and request lifecycle changes stop. Saved credentials are retained.</small></span></label><div class="formGrid" style="margin-top:14px"><div class="formGroup"><label>Request service URL</label><input class="input" type="url" name="baseUrl" maxlength="500" placeholder="https://requests.example.com" value="${esc(status.baseUrl || '')}"><div class="inlineHelp">Public or internal URL CAPTAiNFiN can reach.</div></div><div class="formGroup"><label>API key</label><input class="input" type="password" name="apiKey" autocomplete="new-password" placeholder="${status.apiKeyConfigured ? 'Configured — leave blank to keep current key' : 'Enter API key'}"><div class="inlineHelp">Stored encrypted. It is never rendered back to the browser.</div><label class="toggleRow compact"><input type="checkbox" name="clearApiKey"><span>Clear saved API key</span></label></div><div class="formGroup"><label>User sync interval · minutes</label><input class="input" type="number" min="5" max="1440" name="syncIntervalMinutes" value="${esc(status.syncIntervalMinutes || 15)}"><div class="inlineHelp">Applies without a container restart.</div></div></div><div class="buttonRow"><button class="button" type="submit">Save request integration</button>${status.source === 'database' ? `<button class="button secondary" type="submit" name="useEnvironment" value="1">Use environment fallback instead</button>` : ''}</div></form><div class="formPanel" style="margin-top:10px"><div class="sectionHead"><div><strong>Connection validation</strong><div class="subText">${esc(source)} · Tests the saved URL and API key against the request-service user API.</div></div><div class="buttonRow">${open}<form method="post" action="/admin/request-users/test" class="inlineForm">${csrfInput(req)}<button class="button secondary" type="submit" ${testDisabled ? 'disabled' : ''}>Test connection</button></form></div></div></div></section>`;
}

function bulkBar(req, configured) {
  return `<form id="requestUserBulkForm" class="formPanel requestUserBulkBar" method="post" action="/admin/request-users/sync-selected">${csrfInput(req)}<strong><span data-request-selected-count>0</span> selected</strong><span class="muted">Use the current plan policy, or move the selected customers to another plan.</span><div class="buttonRow"><button class="button secondary" type="submit" data-requires-request-selection ${configured ? '' : 'disabled'}>Sync selected</button><button class="button secondary" type="submit" formaction="/admin/customers/bulk/preview" name="action" value="plan_change" data-requires-request-selection>Manual entitlement edit…</button></div></form>`;
}

async function page(req) {
  await requestServiceSettings.ensureLoaded();
  const [summary, candidates, integration] = await Promise.all([requestUsers.statusSummary(), requestUsers.syncCandidates(), requestServiceSettings.status()]);
  const counts = summary.counts || {}, configured = integration.configured;
  const active = candidates.filter(row => row.entitlement_active && row.request_access_enabled !== false).length;
  const passwordsNeeded = candidates.filter(row => row.password_reset_required && !row.access_suspended && row.request_access_enabled !== false).length;

  const lifecycleCard = `<section class="card"><div class="card-header"><div><h2 class="card-title">Request access lifecycle</h2><div class="muted">CAPTAiNFiN owns request identity, plan quotas and plan-selected Jellyseerr policy; Jellyseerr remains the content-request frontend.</div></div></div><div class="card-body"><div class="compact-item"><div><div class="compact-title">One request identity per customer</div><div class="compact-meta">A customer can move between Jellyfin servers without creating another request account.</div></div><span class="pill good">Centralised</span></div><div class="compact-item"><div><div class="compact-title">Plan request policy</div><div class="compact-meta">Quota, request access and optional customer-safe Jellyseerr permissions come from the current CAPTAiNFiN plan.</div></div><span class="pill good">Plan controlled</span></div><div class="compact-item"><div><div class="compact-title">Subscription lifecycle</div><div class="compact-meta">Expired or plan-disabled request access sets permissions to zero without deleting the account or request history.</div></div><span class="pill good">Automatic</span></div></div></section>`;
  const metrics = `<div class="metrics" style="margin-top:16px"><div class="metric"><div class="metricLabel">Active request access</div><div class="metricValue smallish">${active}</div></div><div class="metric"><div class="metricLabel">Suspended</div><div class="metricValue smallish">${summary.suspended || 0}</div></div><div class="metric"><div class="metricLabel">Need request password</div><div class="metricValue smallish">${passwordsNeeded}</div></div><div class="metric"><div class="metricLabel">Failed</div><div class="metricValue smallish">${counts.failed || 0}</div></div></div>`;

  const rows = candidates.map(row => {
    const loginEmail = row.external_email || row.email || 'Assigned at first sync', state = row.status || 'pending';
    let access;
    if (!row.entitlement_active) access = '<span class="pill warn">Suspended</span>';
    else if (row.request_access_enabled === false) access = '<span class="pill warn">Plan off</span>';
    else if (row.access_suspended) access = '<span class="pill warn">Needs sync</span>';
    else access = '<span class="pill good">Active</span>';
    const password = row.password_reset_required && !row.access_suspended && row.request_access_enabled !== false ? '<span class="pill warn">Password needed</span>' : row.external_user_id ? '<span class="pill good">Ready</span>' : '—';
    const movie = row.entitlement_active ? quota(row.request_movie_quota_limit, row.request_movie_quota_days) : quota(row.applied_movie_quota_limit, row.applied_movie_quota_days);
    const tv = row.entitlement_active ? quota(row.request_tv_quota_limit, row.request_tv_quota_days) : quota(row.applied_tv_quota_limit, row.applied_tv_quota_days);
    const permissionMeta = row.entitlement_active ? (row.request_permissions == null ? 'preserve permissions' : 'plan permissions') : 'no active entitlement';
    return `<tr><td data-label="Select"><input type="checkbox" form="requestUserBulkForm" name="customerId" value="${esc(row.customer_id)}" data-request-user-select aria-label="Select ${esc(row.username || 'user')}"></td><td><strong>${esc(row.username || 'User')}</strong><div class="planMeta">${esc(loginEmail)}</div></td><td>${access}<div class="planMeta">${row.entitlement_active ? `${esc(row.plan_name || row.plan_code || 'Active plan')} · ${esc(permissionMeta)}` : 'No active entitlement'}</div></td><td><strong>${esc(movie)}</strong><div class="planMeta">movies</div></td><td><strong>${esc(tv)}</strong><div class="planMeta">TV seasons</div></td><td>${esc(row.active_servers || '—')}<div class="planMeta">${esc(row.active_server_count || 0)} active server${Number(row.active_server_count) === 1 ? '' : 's'}</div></td><td>${pill(state)}</td><td>${row.external_user_id ? `#${esc(row.external_user_id)}<div class="planMeta">${esc(row.external_username || '')}</div>` : '—'}</td><td>${password}</td><td>${esc(dt(row.last_success_at || row.last_attempt_at))}</td><td class="problemCell" title="${esc(row.last_error || '')}">${esc(row.last_error || '—')}</td><td class="right"><form method="post" action="/admin/request-users/${esc(row.customer_id)}/sync">${csrfInput(req)}<button class="button secondary" type="submit" ${configured ? '' : 'disabled'}>Sync</button></form></td></tr>`;
  }).join('');

  const table = `<section class="section"><div class="sectionHead"><div><h2>Managed request users</h2><div class="muted">Select users to reapply their current plan policy or to move them through the existing safe bulk plan-change workflow.</div></div><span class="muted">${candidates.length} managed</span></div>${candidates.length ? `${bulkBar(req, configured)}<div class="tableWrap"><table class="dataTable requestUserTable"><thead><tr><th><input type="checkbox" data-request-user-select-all aria-label="Select all managed request users"></th><th>Customer / login</th><th>Access</th><th>Movies</th><th>TV</th><th>Jellyfin servers</th><th>Sync</th><th>Request user</th><th>Login</th><th>Last sync</th><th>Problem</th><th class="right">Action</th></tr></thead><tbody>${rows}</tbody></table></div><script src="/js/admin-request-users-bulk.js" defer></script>` : '<div class="empty">No managed request users yet.</div>'}</section>`;
  const action = `<form method="post" action="/admin/request-users/sync-all">${csrfInput(req)}<button class="button" type="submit" ${configured ? '' : 'disabled'}>Sync all users</button></form>`;
  const styles = '<style>.requestUserTable{min-width:1540px}.problemCell{max-width:300px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.metricValue.smallish{font-size:22px}.inlineForm{display:inline;margin:0}.requestUserBulkBar{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:10px}.requestUserBulkBar>.muted{flex:1 1 320px}.requestUserBulkBar .buttonRow{margin:0}</style>';
  return layout({ siteName: runtimeSettings.siteName(), active: 'request-service', title: 'Request Service', subtitle: 'Central Overseerr / Jellyseerr / Seerr integration for every managed Jellyfin server', action, body: `${styles}${notice(req)}${configPanel(req, integration)}${lifecycleCard}${metrics}${table}` });
}

function createAdminRequestUsersRouter() {
  const router = express.Router();
  router.use('/admin/request-users', gate, noStore);
  router.get('/admin/request-users', async (req, res, next) => { try { return res.send(await page(req)); } catch (error) { return next(error); } });
  router.post('/admin/request-users/settings', writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      if (req.body.useEnvironment === '1') { await requestServiceSettings.useEnvironment(req.session.authUserId); return res.redirect('/admin/request-users?message=' + encodeURIComponent('Request service now uses environment fallback settings.')); }
      await requestServiceSettings.save({ enabled: checked(req.body.enabled), baseUrl: req.body.baseUrl, apiKey: req.body.apiKey, clearApiKey: checked(req.body.clearApiKey), syncIntervalMinutes: req.body.syncIntervalMinutes }, req.session.authUserId);
      return res.redirect('/admin/request-users?message=' + encodeURIComponent('Request service settings saved securely.'));
    } catch (error) { return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Request service settings could not be saved.')); }
  });
  router.post('/admin/request-users/test', writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try { const result = await requestServiceSettings.testConnection(); return res.redirect('/admin/request-users?message=' + encodeURIComponent(result.message)); }
    catch (error) { return res.redirect('/admin/request-users?error=' + encodeURIComponent(`Request service test failed: ${error.message || error}`)); }
  });
  router.post('/admin/request-users/sync-all', writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try { await requestServiceSettings.ensureLoaded(); const result = await requestUsers.syncAll(); return res.redirect('/admin/request-users?message=' + encodeURIComponent(syncSummaryMessage('Request users synced', result))); }
    catch (error) { return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Request user sync failed.')); }
  });
  router.post('/admin/request-users/sync-selected', writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try { await requestServiceSettings.ensureLoaded(); const result = await requestUsers.syncSelected(req.body.customerId); return res.redirect('/admin/request-users?message=' + encodeURIComponent(syncSummaryMessage(`${result.total} selected request users synced`, result))); }
    catch (error) { return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Selected request users could not be synced.')); }
  });
  router.post('/admin/request-users/:customerId/sync', writeLimit, async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      await requestServiceSettings.ensureLoaded();
      const result = await requestUsers.syncOneCustomer(req.params.customerId);
      const message = result.status === 'synced' ? 'Request user synced.' : result.status === 'suspended' ? 'Request access suspended; history preserved.' : `Request user ${result.status}.`;
      return res.redirect('/admin/request-users?message=' + encodeURIComponent(message));
    } catch (error) { return res.redirect('/admin/request-users?error=' + encodeURIComponent(error.message || 'Request user sync failed.')); }
  });
  return router;
}

module.exports = { createAdminRequestUsersRouter, page };