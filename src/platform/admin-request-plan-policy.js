'use strict';

const express = require('express');
const { query } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const policy = require('../integrations/request-plan-policy');
const planCommands = require('../catalog/plan-command-service');
const { queuePlanRequestReconciliation } = require('./bulk-jobs');
const { esc } = require('./admin-html');

const writeLimit = routeRateLimit.middleware({ scope: 'admin-request-plan-policy-write', max: 60, windowSeconds: 60, reason: 'admin_request_plan_policy_write' });

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
function freeJellyfinPlan(plan){
  const service=String(plan?.service_type||'jellyfin');
  if(!['jellyfin','bundle'].includes(service))return false;
  return Boolean(plan?.is_free_tier)||(Number(plan?.price_minor||0)===0&&String(plan?.billing_interval||'')!=='trial'&&String(plan?.server_class||'')==='free');
}
function freeInactivityCard(req,plan){
  if(!freeJellyfinPlan(plan))return'';
  const raw=plan?.inactivity_policy&&typeof plan.inactivity_policy==='object'?plan.inactivity_policy:{};
  const configured=['firstPlaybackGraceDays','playbackWindowDays','minimumPlaybackMinutes'].every(key=>Number.isInteger(Number(raw[key])));
  const owner=configured?'Plan-owned':'Legacy-safe fallback';
  const help=configured
    ? 'These thresholds are owned by this Free plan and apply regardless of which eligible server receives the customer.'
    : 'No complete plan policy has been saved yet, so enforcement continues using each assigned server\'s existing thresholds exactly as before. Saving this form switches this plan to plan-owned thresholds.';
  return `<section class="planConfigCard freeInactivityPlanCard" id="free-activity"><div class="planConfigHead"><div><h2>Free plan inactivity rules</h2><p>These rules belong to the Free plan; the global lifecycle page remains the emergency enable/dry-run switch.</p></div><span class="pill ${configured?'good':'warn'}">${esc(owner)}</span></div><form class="planConfigBody" method="post" action="/admin/request-plan-policy/${esc(plan.id)}/free-inactivity">${csrfInput(req)}<div class="securityNote standalone"><strong>Safe transition:</strong> ${esc(help)}</div><div class="formGrid"><div class="formGroup"><label>First playback grace</label><div class="inputUnit"><input class="input" type="number" min="1" max="3650" name="firstPlaybackGraceDays" value="${esc(configured?raw.firstPlaybackGraceDays:'')}" placeholder="e.g. 3" required><span>days</span></div></div><div class="formGroup"><label>Rolling playback window</label><div class="inputUnit"><input class="input" type="number" min="1" max="365" name="playbackWindowDays" value="${esc(configured?raw.playbackWindowDays:'')}" placeholder="e.g. 7" required><span>days</span></div></div><div class="formGroup"><label>Minimum playback</label><div class="inputUnit"><input class="input" type="number" min="1" max="1000000" name="minimumPlaybackMinutes" value="${esc(configured?raw.minimumPlaybackMinutes:'')}" placeholder="e.g. 30" required><span>minutes</span></div></div></div><div class="buttonRow"><button class="button">Save Free inactivity rules</button><a class="button secondary" href="/admin/settings/jellyfin-lifecycle">Automation mode</a></div><div class="planSaveHint">Changing these thresholds never removes a customer immediately from this request; the scheduled inactivity worker still performs its normal final eligibility and active-playback safety checks.</div></form></section>`;
}
function planCard(req, plan, { variant = 'jellyfin' } = {}) {
  const managed = plan.request_permissions !== null && plan.request_permissions !== undefined;
  const accessEnabled = plan.request_access_enabled !== false;
  const outerClass = variant === 'stremio' ? 'section stremioCard requestPlanCard' : 'planConfigCard span3 requestPlanCard';
  const headClass = variant === 'stremio' ? 'sectionHead' : 'planConfigHead';
  const bodyClass = variant === 'stremio' ? 'requestPlanBody' : 'planConfigBody requestPlanBody';
  const badge = accessEnabled ? '<span class="pill good">Enabled</span>' : '<span class="pill warn">Disabled</span>';
  const destructiveConfirm = accessEnabled ? `<label class="toggleRow"><input type="checkbox" name="confirmRequestDeletion" value="yes"><span><strong>I understand disabling request access deletes managed Seerr accounts</strong><small>Required when turning request access off. Seerr request history owned by those deleted accounts is permanently removed.</small></span></label>` : '';
  const requestCard=`<section class="${outerClass}" id="requests"><div class="${headClass}"><div><h2>Requests / Jellyseerr</h2><p class="muted">Request quota, permissions and plan-owned user defaults. Saving automatically reconciles every current member of this plan.</p></div>${badge}</div><form class="${bodyClass}" method="post" action="/admin/request-plan-policy/${esc(plan.id)}">${csrfInput(req)}<input type="hidden" name="returnToPlan" value="1">
    <label class="toggleRow"><input type="checkbox" name="requestAccessEnabled" ${checked(accessEnabled)}><span><strong>Request-service access</strong><small>When off, Fin-Fusion removes each ineligible managed Seerr account. Deleting a Seerr user permanently removes that user's Seerr request history.</small></span></label>
    ${destructiveConfirm}
    <div class="formGrid requestQuotaGrid">
      <div class="formGroup"><label>Movie requests</label><input class="input" type="number" min="1" max="10000" name="movieLimit" value="${esc(plan.request_movie_quota_limit ?? '')}" placeholder="Unlimited"><div class="inlineHelp">Leave blank for unlimited.</div></div>
      <div class="formGroup"><label>Movie quota window</label><div class="inputUnit"><input class="input" type="number" min="1" max="3650" name="movieDays" value="${esc(plan.request_movie_quota_days || 30)}" required><span>days</span></div></div>
      <div class="formGroup"><label>TV season requests</label><input class="input" type="number" min="1" max="10000" name="tvLimit" value="${esc(plan.request_tv_quota_limit ?? '')}" placeholder="Unlimited"><div class="inlineHelp">Jellyseerr counts requested seasons.</div></div>
      <div class="formGroup"><label>TV quota window</label><div class="inputUnit"><input class="input" type="number" min="1" max="3650" name="tvDays" value="${esc(plan.request_tv_quota_days || 30)}" required><span>days</span></div></div>
    </div>
    <fieldset class="requestPermissionMode"><legend>Jellyseerr permissions</legend><label class="choice"><input type="radio" name="permissionMode" value="preserve" ${managed ? '' : 'checked'}><span><strong>Preserve current user permissions</strong><small>Best for imported users until this plan is ready to become authoritative.</small></span></label><label class="choice"><input type="radio" name="permissionMode" value="managed" ${managed ? 'checked' : ''}><span><strong>Plan controls permissions</strong><small>CAPTAiNFiN writes the exact customer-safe permission set below on every sync.</small></span></label></fieldset>
    <details class="planCardDetails" ${managed ? 'open' : ''}><summary>Customer permissions</summary><div class="planDetailsBody">${permissionGroups(plan)}<div class="securityNote standalone"><strong>Privilege boundary:</strong> customer plans can never grant Jellyseerr administrator, settings-management, user-management, request-management, issue-management or blocklist-management permissions.</div></div></details>
    <details class="planCardDetails"><summary>Plan-owned Jellyseerr defaults</summary><div class="planDetailsBody"><div class="formGrid">${triStateSelect('watchlistSyncMovies', 'Movie watchlist sync', plan.request_watchlist_sync_movies)}${triStateSelect('watchlistSyncTv', 'TV watchlist sync', plan.request_watchlist_sync_tv)}<div class="formGroup"><label>Locale override</label><input class="input" name="locale" maxlength="32" value="${esc(plan.request_locale || '')}" placeholder="Preserve user setting"></div><div class="formGroup"><label>Discover region override</label><input class="input" name="discoverRegion" maxlength="16" value="${esc(plan.request_discover_region || '')}" placeholder="Preserve user setting"></div><div class="formGroup"><label>Streaming region override</label><input class="input" name="streamingRegion" maxlength="16" value="${esc(plan.request_streaming_region || '')}" placeholder="Preserve user setting"></div><div class="formGroup"><label>Original language override</label><input class="input" name="originalLanguage" maxlength="32" value="${esc(plan.request_original_language || '')}" placeholder="Preserve user setting"></div></div><div class="inlineHelp">Username, email, password and personal notification destinations remain user-owned and are never defined by a plan.</div></div></details>
    <div class="buttonRow"><button class="button" type="submit">Save request policy</button><a class="button secondary" href="/admin/request-users">Managed request users</a></div><div class="planSaveHint">Current plan members are queued automatically so new limits and permissions reach Jellyseerr without a manual bulk sync.</div>
  </form></section>`;
  return variant==='jellyfin'?`${freeInactivityCard(req,plan)}${requestCard}`:requestCard;
}

function redirectTarget(req, planId, kind, message) {
  if (String(req.body.returnToPlan || '') === '1') return `/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}#requests`;
  return `/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}#requests`;
}
function legacyInactivityRedirect(planId,message){return `/admin/plans/${encodeURIComponent(planId)}/edit?message=${encodeURIComponent(message)}#free-activity`;}

function createAdminRequestPlanPolicyRouter() {
  const router = express.Router();
  router.use('/admin/request-plan-policy', gate, noStore);
  router.get('/admin/request-plan-policy', (_req, res) => res.redirect(302, '/admin/plans'));
  router.post('/admin/request-plan-policy/:planId/free-inactivity',writeLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const planId=req.params.planId;
      const found=await query('SELECT id,is_free_tier,service_type,price_minor,billing_interval,server_class FROM plans WHERE id=$1',[planId]);
      const plan=found.rows[0]||null;
      if(!plan||!freeJellyfinPlan(plan))throw new Error('Free inactivity rules apply only to the Free Jellyfin plan.');
      const whole=(value,min,max,label)=>{const n=Number(value);if(!Number.isInteger(n)||n<min||n>max)throw new Error(`${label} must be a whole number from ${min} to ${max}.`);return n;};
      const inactivityPolicy={
        firstPlaybackGraceDays:whole(req.body.firstPlaybackGraceDays,1,3650,'First playback grace'),
        playbackWindowDays:whole(req.body.playbackWindowDays,1,365,'Playback window'),
        minimumPlaybackMinutes:whole(req.body.minimumPlaybackMinutes,1,1000000,'Minimum playback minutes')
      };
      await planCommands.updateInactivityPolicy({planId,policy:inactivityPolicy,actorUserId:req.session.authUserId});
      return res.redirect(legacyInactivityRedirect(planId,'Free plan inactivity rules saved. Existing Free automation safeguards are unchanged.'));
    }catch(error){
      return res.redirect(`/admin/plans/${encodeURIComponent(req.params.planId)}/edit?error=${encodeURIComponent(error.message||'Free inactivity rules could not be saved.')}#free-activity`);
    }
  });
  router.post('/admin/request-plan-policy/:planId', writeLimit, async (req, res) => {
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
      const updated = await planCommands.updateRequestPolicy({
        planId: req.params.planId,
        movieLimit,
        movieDays,
        tvLimit,
        tvDays,
        requestAccessEnabled,
        requestPermissions,
        watchlistSyncMovies,
        watchlistSyncTv,
        locale,
        discoverRegion,
        streamingRegion,
        originalLanguage,
        confirmDestructiveDisable: String(req.body.confirmRequestDeletion || '') === 'yes',
        actorUserId: req.session.authUserId
      });
      const job = await queuePlanRequestReconciliation(req.params.planId, req.session.authUserId);
      const fanout = job ? ` ${Number(job.total_items || 0)} current member${Number(job.total_items || 0) === 1 ? '' : 's'} queued for Jellyseerr sync.` : ' No current plan members needed syncing.';
      const message = `${updated.plan.name} request policy saved.${fanout}`;
      return res.redirect(redirectTarget(req, req.params.planId, 'message', message));
    } catch (error) {
      return res.redirect(redirectTarget(req, req.params.planId, 'error', error.message || 'Request policy could not be saved.'));
    }
  });
  return router;
}

module.exports = { createAdminRequestPlanPolicyRouter, planCard, freeInactivityCard, optionalLimit, days };
