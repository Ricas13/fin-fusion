'use strict';

const express = require('express');
const { query, transaction } = require('../db');
const csrf = require('../auth/csrf');
const runtimeSettings = require('./runtime-settings');
const policy = require('../integrations/request-plan-policy');
const { layout, esc } = require('./admin-html');

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
function notice(req) {
  return `${req.query.message ? `<div class="notice success">${esc(req.query.message)}</div>` : ''}${req.query.error ? `<div class="notice error">${esc(req.query.error)}</div>` : ''}`;
}
function checked(value) { return value ? 'checked' : ''; }
function selected(a, b) { return String(a) === String(b) ? 'selected' : ''; }
function optionalLimit(value) {
  if (value == null || String(value).trim() === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 10000) throw new Error('Request quota must be between 1 and 10,000, or left blank for unlimited.');
  return n;
}
function days(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 3650) throw new Error('Quota window must be between 1 and 3,650 days.');
  return n;
}
function quotaLabel(limit, window) {
  return limit == null ? 'Unlimited' : `${limit} / ${window} day${Number(window) === 1 ? '' : 's'}`;
}
function triStateSelect(name, label, value, help = '') {
  const current = value === true ? 'enabled' : value === false ? 'disabled' : 'preserve';
  return `<div class="formGroup"><label>${esc(label)}</label><select class="input" name="${esc(name)}"><option value="preserve" ${selected(current, 'preserve')}>Preserve user setting</option><option value="enabled" ${selected(current, 'enabled')}>Enabled</option><option value="disabled" ${selected(current, 'disabled')}>Disabled</option></select>${help ? `<div class="inlineHelp">${esc(help)}</div>` : ''}</div>`;
}
function permissionGroups(plan) {
  const groups = new Map();
  for (const item of policy.CUSTOMER_PERMISSION_DEFS) {
    if (!groups.has(item.group)) groups.set(item.group, []);
    groups.get(item.group).push(item);
  }
  const mask = policy.sanitizePermissionMask(plan.request_permissions);
  return [...groups.entries()].map(([group, items]) => `<div class="requestPermissionGroup"><strong>${esc(group)}</strong><div class="planPermissionGrid">${items.map(item => `<label class="toggleRow"><input type="checkbox" name="permission_${item.bit}" ${checked(policy.permissionEnabled(mask, item.bit))}><span><strong>${esc(item.label)}</strong>${item.help ? `<small>${esc(item.help)}</small>` : ''}</span></label>`).join('')}</div></div>`).join('');
}
function planCard(req, plan, { variant = 'jellyfin' } = {}) {
  const managed = plan.request_permissions !== null && plan.request_permissions !== undefined;
  const accessEnabled = plan.request_access_enabled !== false;
  const outerClass = variant === 'stremio' ? 'section stremioCard requestPlanCard' : 'planConfigCard span3 requestPlanCard';
  const headClass = variant === 'stremio' ? 'sectionHead' : 'planConfigHead';
  const bodyClass = variant === 'stremio' ? 'requestPlanBody' : 'planConfigBody requestPlanBody';
  const badge = accessEnabled ? '<span class="pill good">Enabled</span>' : '<span class="pill warn">Suspended</span>';
  return `<section class="${outerClass}" id="requests"><div class="${headClass}"><div><h2>Requests / Jellyseerr</h2><p class="muted">Request quota, permissions and plan-owned user defaults. Applied whenever the customer's request account synchronizes.</p></div>${badge}</div><form class="${bodyClass}" method="post" action="/admin/request-plan-policy/${esc(plan.id)}">${csrfInput(req)}<input type="hidden" name="returnToPlan" value="1">
    <label class="toggleRow"><input type="checkbox" name="requestAccessEnabled" ${checked(accessEnabled)}><span><strong>Request-service access</strong><small>When off, Jellyseerr permissions are set to zero while the account and request history are preserved.</small></span></label>
    <div class="formGrid requestQuotaGrid">
      <div class="formGroup"><label>Movie requests</label><input class="input" type="number" min="1" max="10000" name="movieLimit" value="${esc(plan.request_movie_quota_limit ?? '')}" placeholder="Unlimited"><div class="inlineHelp">Leave blank for unlimited.</div></div>
      <div class="formGroup"><label>Movie quota window</label><div class="inputUnit"><input class="input" type="number" min="1" max="3650" name="movieDays" value="${esc(plan.request_movie_quota_days || 30)}" required><span>days</span></div></div>
      <div class="formGroup"><label>TV season requests</label><input class="input" type="number" min="1" max="10000" name="tvLimit" value="${esc(plan.request_tv_quota_limit ?? '')}" placeholder="Unlimited"><div class="inlineHelp">Jellyseerr counts requested seasons.</div></div>
      <div class="formGroup"><label>TV quota window</label><div class="inputUnit"><input class="input" type="number" min="1" max="3650" name="tvDays" value="${esc(plan.request_tv_quota_days || 30)}" required><span>days</span></div></div>
    </div>
    <fieldset class="requestPermissionMode"><legend>Jellyseerr permissions</legend><label class="choice"><input type="radio" name="permissionMode" value="preserve" ${managed ? '' : 'checked'}><span><strong>Preserve current user permissions</strong><small>Best for imported users until this plan is ready to become authoritative.</small></span></label><label class="choice"><input type="radio" name="permissionMode" value="managed" ${managed ? 'checked' : ''}><span><strong>Plan controls permissions</strong><small>CAPTAiNFiN writes the exact customer-safe permission set below on every sync.</small></span></label></fieldset>
    <details class="planCardDetails" ${managed ? 'open' : ''}><summary>Customer permissions</summary><div class="planDetailsBody">${permissionGroups(plan)}<div class="securityNote standalone"><strong>Privilege boundary:</strong> customer plans can never grant Jellyseerr administrator, settings-management, user-management, request-management, issue-management or blocklist-management permissions.</div></div></details>
    <details class="planCardDetails"><summary>Plan-owned Jellyseerr defaults</summary><div class="planDetailsBody"><div class="formGrid">${triStateSelect('watchlistSyncMovies', 'Movie watchlist sync', plan.request_watchlist_sync_movies)}${triStateSelect('watchlistSyncTv', 'TV watchlist sync', plan.request_watchlist_sync_tv)}<div class="formGroup"><label>Locale override</label><input class="input" name="locale" maxlength="32" value="${esc(plan.request_locale || '')}" placeholder="Preserve user setting"></div><div class="formGroup"><label>Discover region override</label><input class="input" name="discoverRegion" maxlength="16" value="${esc(plan.request_discover_region || '')}" placeholder="Preserve user setting"></div><div class="formGroup"><label>Streaming region override</label><input class="input" name="streamingRegion" maxlength="16" value="${esc(plan.request_streaming_region || '')}" placeholder="Preserve user setting"></div><div class="formGroup"><label>Original language override</label><input class="input" name="originalLanguage" maxlength="32" value="${esc(plan.request_original_language || '')}" placeholder="Preserve user setting"></div></div><div class="inlineHelp">Username, email, password and personal notification destinations remain user-owned and are never defined by a plan.</div></div></details>
    <div class="buttonRow"><button class="button" type="submit">Save request policy</button><a class="button secondary" href="/admin/request-users">Managed request users</a></div><div class="planSaveHint">Existing users receive the new policy at the next scheduled, individual or bulk sync.</div>
  </form></section>`;
}

async function plans() {
  const result = await query(`
    SELECT p.*,
      (SELECT COUNT(DISTINCT s.customer_id)::int FROM subscriptions s
       WHERE s.plan_id=p.id AND s.superseded_by IS NULL
         AND s.status IN ('active','trialing','past_due','paused')
         AND s.starts_at<=NOW() AND s.current_period_end>NOW()) AS active_customers
    FROM plans p
    WHERE p.archived_at IS NULL
    ORDER BY p.active DESC,p.sort_order,p.price_minor,p.name
  `);
  return result.rows;
}

async function page(req) {
  const rows = await plans();
  const tableRows = rows.map(plan => `<tr><td><strong>${esc(plan.name)}</strong><div class="planMeta">${esc(plan.code)} · ${esc(plan.service_type || 'jellyfin')}</div></td><td>${plan.request_access_enabled === false ? '<span class="pill warn">Off</span>' : '<span class="pill good">On</span>'}</td><td><strong>${esc(quotaLabel(plan.request_movie_quota_limit, plan.request_movie_quota_days))}</strong></td><td><strong>${esc(quotaLabel(plan.request_tv_quota_limit, plan.request_tv_quota_days))}</strong></td><td>${plan.request_permissions == null ? '<span class="pill">Preserve user</span>' : '<span class="pill good">Plan controlled</span>'}</td><td>${esc(plan.active_customers || 0)}</td><td class="right"><a class="button secondary btn-sm" href="/admin/plans/${encodeURIComponent(plan.id)}/edit#requests">Edit in plan</a></td></tr>`).join('');
  const body = `${notice(req)}<section class="card"><div class="card-header"><div><h2 class="card-title">Plan-owned request policy</h2><div class="muted">Request configuration now lives with each product. This page is the cross-plan overview.</div></div></div><div class="card-body"><div class="compact-item"><div><div class="compact-title">One source of truth</div><div class="compact-meta">Quotas, customer-safe permissions and optional Jellyseerr defaults are configured on the plan itself.</div></div><span class="pill good">Plan controlled</span></div><div class="compact-item"><div><div class="compact-title">Imported-user safe</div><div class="compact-meta">Permission mode defaults to Preserve, so existing Jellyseerr permissions are not silently replaced.</div></div><span class="pill">Compatible</span></div></div></section><section class="section"><div class="sectionHead"><div><h2>Request policy by plan</h2><div class="muted">Open a plan to configure its full Requests / Jellyseerr card.</div></div><span class="muted">${rows.length} plans</span></div>${rows.length ? `<div class="tableWrap"><table class="dataTable"><thead><tr><th>Plan</th><th>Access</th><th>Movies</th><th>TV seasons</th><th>Permissions</th><th>Customers</th><th></th></tr></thead><tbody>${tableRows}</tbody></table></div>` : '<div class="empty">No plans exist yet.</div>'}</section>`;
  return layout({ siteName: runtimeSettings.siteName(), active: 'request-plan-limits', title: 'Plan Request Policy', subtitle: 'Jellyseerr access, quotas and customer-safe permissions', body });
}

function redirectTarget(req, planId, kind, message) {
  if (String(req.body.returnToPlan || '') === '1') return `/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}#requests`;
  return `/admin/request-plan-policy?${kind}=${encodeURIComponent(message)}`;
}

function createAdminRequestPlanPolicyRouter() {
  const router = express.Router();
  router.use('/admin/request-plan-policy', gate, noStore);
  router.get('/admin/request-plan-policy', async (req, res, next) => {
    try { return res.send(await page(req)); } catch (error) { return next(error); }
  });
  router.post('/admin/request-plan-policy/:planId', async (req, res) => {
    if (!csrf.verify(req)) return res.status(403).send('Invalid security token');
    try {
      const movieLimit = optionalLimit(req.body.movieLimit), movieDays = days(req.body.movieDays);
      const tvLimit = optionalLimit(req.body.tvLimit), tvDays = days(req.body.tvDays);
      const requestAccessEnabled = req.body.requestAccessEnabled === 'on' || req.body.requestAccessEnabled === '1';
      const requestPermissions = policy.permissionMaskFromBody(req.body);
      const watchlistSyncMovies = policy.triState(req.body.watchlistSyncMovies);
      const watchlistSyncTv = policy.triState(req.body.watchlistSyncTv);
      const locale = policy.optionalText(req.body.locale, 32);
      const discoverRegion = policy.optionalText(req.body.discoverRegion, 16);
      const streamingRegion = policy.optionalText(req.body.streamingRegion, 16);
      const originalLanguage = policy.optionalText(req.body.originalLanguage, 32);
      let updated;
      await transaction(async client => {
        updated = await client.query(`UPDATE plans SET request_movie_quota_limit=$2,request_movie_quota_days=$3,request_tv_quota_limit=$4,request_tv_quota_days=$5,request_access_enabled=$6,request_permissions=$7,request_watchlist_sync_movies=$8,request_watchlist_sync_tv=$9,request_locale=$10,request_discover_region=$11,request_streaming_region=$12,request_original_language=$13,updated_at=NOW() WHERE id=$1 RETURNING name,service_type`, [req.params.planId, movieLimit, movieDays, tvLimit, tvDays, requestAccessEnabled, requestPermissions, watchlistSyncMovies, watchlistSyncTv, locale, discoverRegion, streamingRegion, originalLanguage]);
        if (!updated.rowCount) throw new Error('Plan not found.');
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'plan.request_policy.update','plan',$2,$3::jsonb)`, [req.session.authUserId, req.params.planId, JSON.stringify({ movieLimit, movieDays, tvLimit, tvDays, requestAccessEnabled, permissionMode: requestPermissions == null ? 'preserve' : 'managed', requestPermissions, watchlistSyncMovies, watchlistSyncTv, locale, discoverRegion, streamingRegion, originalLanguage })]);
      });
      const message = `${updated.rows[0].name} request policy saved. Existing users will receive it on their next sync.`;
      return res.redirect(redirectTarget(req, req.params.planId, 'message', message));
    } catch (error) {
      return res.redirect(redirectTarget(req, req.params.planId, 'error', error.message || 'Request policy could not be saved.'));
    }
  });
  return router;
}

module.exports = { createAdminRequestPlanPolicyRouter, page, planCard, optionalLimit, days, plans };
