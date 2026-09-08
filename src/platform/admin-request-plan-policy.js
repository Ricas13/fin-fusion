'use strict';

const express = require('express');
const { transaction } = require('../db');
const csrf = require('../auth/csrf');
const routeRateLimit = require('../security/route-rate-limit');
const policy = require('../integrations/request-plan-policy');
const planLifecyclePolicy = require('../entitlements/plan-lifecycle-policy');
const jellyfinLifecyclePolicy = require('../entitlements/jellyfin-lifecycle-policy');
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
function wholeNumber(value,min,max,label){
  const raw=String(value??'').trim(),n=Number.parseInt(raw,10);
  if(!Number.isInteger(n)||String(n)!==raw||n<min||n>max)throw new Error(`${label} must be a whole number from ${min} to ${max}.`);
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
function integerOr(value,fallback,min,max){const n=Number.parseInt(value,10);return Number.isInteger(n)&&n>=min&&n<=max?n:fallback;}
function freeInactivityValues(plan){
  const raw=plan?.inactivity_policy||{},defaults=jellyfinLifecyclePolicy.DEFAULTS;
  return{
    firstPlaybackGraceDays:integerOr(raw.firstPlaybackGraceDays,defaults.freeFirstPlaybackGraceDays,1,3650),
    activityWindowDays:integerOr(raw.noPlaybackDays,defaults.freeNoPlaybackDays,1,3650),
    minimumPlaybackMinutes:integerOr(raw.minimumPlaybackMinutes,defaults.freeMinimumPlaybackMinutes,1,1000000)
  };
}
function freeInactivityCard(req,plan){
  if(!freeJellyfinPlan(plan))return'';
  const v=freeInactivityValues(plan);
  return `<section class="planConfigCard freeInactivityPlanCard" id="free-activity"><div class="planConfigHead"><div><h2>Free Server activity rules</h2><p>Activation and ongoing retention for this Free plan. These values override the Free Server defaults for this plan.</p></div><span class="pill warn">${esc(v.firstPlaybackGraceDays)}d → ${esc(v.activityWindowDays)}d / ${esc(v.minimumPlaybackMinutes)}m</span></div><form class="planConfigBody" method="post" action="/admin/request-plan-policy/${esc(plan.id)}/free-inactivity">${csrfInput(req)}<input type="hidden" name="returnToPlan" value="1"><div class="formGrid"><div class="formGroup"><label>First playback deadline</label><div class="inputUnit"><input class="input" type="number" min="1" max="3650" name="firstPlaybackGraceDays" value="${esc(v.firstPlaybackGraceDays)}" required><span>days</span></div><div class="inlineHelp">A newly allocated or restored Free place must play something within this many days.</div></div><div class="formGroup"><label>Activity window</label><div class="inputUnit"><input class="input" type="number" min="1" max="365" name="activityWindowDays" value="${esc(v.activityWindowDays)}" required><span>days</span></div><div class="inlineHelp">After the first stream, recent playback and the rolling minute total use this same window.</div></div><div class="formGroup"><label>Minimum playback</label><div class="inputUnit"><input class="input" type="number" min="1" max="1000000" name="minimumPlaybackMinutes" value="${esc(v.minimumPlaybackMinutes)}" required><span>minutes</span></div><div class="inlineHelp">Ongoing removal requires both: no playback inside the activity window and fewer than this many minutes in the rolling window.</div></div></div><div class="securityNote standalone"><strong>Lifecycle:</strong> before first playback the activation deadline is independent. After activation, the account is removed only when both ongoing retention checks are breached. Restoring access starts a fresh activation window and old playback is ignored.</div><div class="buttonRow"><button class="button" type="submit">Save Free Server rules</button></div><div class="planSaveHint">Changes are read by the inactivity worker on its next cycle. The CAPTAiNFiN portal account is preserved if Jellyfin access is removed.</div></form></section>`;
}
function planCard(req, plan, { variant = 'jellyfin' } = {}) {
  const managed = plan.request_permissions !== null && plan.request_permissions !== undefined;
  const accessEnabled = plan.request_access_enabled !== false;
  const outerClass = variant === 'stremio' ? 'section stremioCard requestPlanCard' : 'planConfigCard span3 requestPlanCard';
  const headClass = variant === 'stremio' ? 'sectionHead' : 'planConfigHead';
  const bodyClass = variant === 'stremio' ? 'requestPlanBody' : 'planConfigBody requestPlanBody';
  const badge = accessEnabled ? '<span class="pill good">Enabled</span>' : '<span class="pill warn">Suspended</span>';
  const requestCard=`<section class="${outerClass}" id="requests"><div class="${headClass}"><div><h2>Requests / Jellyseerr</h2><p class="muted">Request quota, permissions and plan-owned user defaults. Saving automatically reconciles every current member of this plan.</p></div>${badge}</div><form class="${bodyClass}" method="post" action="/admin/request-plan-policy/${esc(plan.id)}">${csrfInput(req)}<input type="hidden" name="returnToPlan" value="1">
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
    <div class="buttonRow"><button class="button" type="submit">Save request policy</button><a class="button secondary" href="/admin/request-users">Managed request users</a></div><div class="planSaveHint">Current plan members are queued automatically so new limits and permissions reach Jellyseerr without a manual bulk sync.</div>
  </form></section>`;
  return variant==='jellyfin'?`${freeInactivityCard(req,plan)}${requestCard}`:requestCard;
}

function redirectTarget(req, planId, kind, message) {
  if (String(req.body.returnToPlan || '') === '1') return `/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}#requests`;
  return `/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}#requests`;
}
function freeRedirectTarget(planId,kind,message){return `/admin/plans/${encodeURIComponent(planId)}/edit?${kind}=${encodeURIComponent(message)}#free-activity`;}

function createAdminRequestPlanPolicyRouter() {
  const router = express.Router();
  router.use('/admin/request-plan-policy', gate, noStore);
  // Compatibility only: request policy no longer owns a standalone screen.
  // Old bookmarks land on the canonical Plans control room instead.
  router.get('/admin/request-plan-policy', (_req, res) => res.redirect(302, '/admin/plans'));
  router.post('/admin/request-plan-policy/:planId/free-inactivity',writeLimit,async(req,res)=>{
    if(!csrf.verify(req))return res.status(403).send('Invalid security token');
    try{
      const firstPlaybackGraceDays=wholeNumber(req.body.firstPlaybackGraceDays,1,3650,'First playback deadline');
      const activityWindowDays=wholeNumber(req.body.activityWindowDays,1,365,'Activity window');
      const minimumPlaybackMinutes=wholeNumber(req.body.minimumPlaybackMinutes,1,1000000,'Minimum playback');
      let planName='Free Server';
      await transaction(async client=>{
        const result=await client.query('SELECT id,name,is_free_tier,price_minor,billing_interval,server_class,service_type,inactivity_policy FROM plans WHERE id=$1 FOR UPDATE',[req.params.planId]);
        const plan=result.rows[0];
        if(!plan)throw new Error('Plan not found.');
        if(!freeJellyfinPlan(plan))throw new Error('Free Server activity rules can only be configured on a free Jellyfin plan.');
        planName=plan.name||planName;
        const existing=plan.inactivity_policy||{};
        const value=planLifecyclePolicy.validateForPlan(plan,{...existing,enabled:true,dryRun:false,firstPlaybackGraceDays,noPlaybackDays:activityWindowDays,playbackWindowDays:activityWindowDays,minimumPlaybackMinutes});
        await client.query('UPDATE plans SET inactivity_policy=$2::jsonb,updated_at=NOW() WHERE id=$1',[plan.id,JSON.stringify(value)]);
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'admin.plan.inactivity_policy.update','plan',$2,$3::jsonb)`,[req.session.authUserId,plan.id,JSON.stringify({...value,source:'unified_free_plan_editor',portalAccountPreserved:true,lifecycle:'present_or_deleted'})]);
      });
      return res.redirect(freeRedirectTarget(req.params.planId,'message',`${planName} Free Server rules saved.`));
    }catch(error){return res.redirect(freeRedirectTarget(req.params.planId,'error',error.message||'Free Server activity rules could not be saved.'));}
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
      let updated;
      await transaction(async client => {
        updated = await client.query(`UPDATE plans SET request_movie_quota_limit=$2,request_movie_quota_days=$3,request_tv_quota_limit=$4,request_tv_quota_days=$5,request_access_enabled=$6,request_permissions=$7,request_watchlist_sync_movies=$8,request_watchlist_sync_tv=$9,request_locale=$10,request_discover_region=$11,request_streaming_region=$12,request_original_language=$13,updated_at=NOW() WHERE id=$1 RETURNING name,service_type`, [req.params.planId, movieLimit, movieDays, tvLimit, tvDays, requestAccessEnabled, requestPermissions, watchlistSyncMovies, watchlistSyncTv, locale, discoverRegion, streamingRegion, originalLanguage]);
        if (!updated.rowCount) throw new Error('Plan not found.');
        await client.query(`INSERT INTO audit_log(actor_user_id,action,entity_type,entity_id,metadata) VALUES($1,'plan.request_policy.update','plan',$2,$3::jsonb)`, [req.session.authUserId, req.params.planId, JSON.stringify({ movieLimit, movieDays, tvLimit, tvDays, requestAccessEnabled, permissionMode: requestPermissions == null ? 'preserve' : 'managed', requestPermissions, watchlistSyncMovies, watchlistSyncTv, locale, discoverRegion, streamingRegion, originalLanguage })]);
      });
      const job = await queuePlanRequestReconciliation(req.params.planId, req.session.authUserId);
      const fanout = job ? ` ${Number(job.total_items || 0)} current member${Number(job.total_items || 0) === 1 ? '' : 's'} queued for Jellyseerr sync.` : ' No current plan members needed syncing.';
      const message = `${updated.rows[0].name} request policy saved.${fanout}`;
      return res.redirect(redirectTarget(req, req.params.planId, 'message', message));
    } catch (error) {
      return res.redirect(redirectTarget(req, req.params.planId, 'error', error.message || 'Request policy could not be saved.'));
    }
  });
  return router;
}

module.exports = { createAdminRequestPlanPolicyRouter, planCard, freeInactivityCard, freeInactivityValues, optionalLimit, days };
